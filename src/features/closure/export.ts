import 'server-only';

import { getHeapStatistics } from 'node:v8';

import type { JobRun } from '@/lib/jobs';
import type { createAdminClient } from '@/lib/supabase/admin';
import { zipArchive, zipEntry } from '@/lib/zip';

import type { ExportClaim } from './closure';
import {
  COLUMNS,
  EXPORT_MEMORY_CAP,
  EXPORT_ROW_BYTES,
  exportFiles,
  exportMemoryEstimate,
  type ExportCounts,
  type ExportData,
} from './export-files';

export const EXPORT_BUCKET = 'restaurant-exports';

/**
 * A claim on an export lasts this long without a heartbeat, which renews it this often
 * (docs/DECISIONS.md VPS-26). A build whose server died lets its lease lapse within 90 s of its
 * last heartbeat, and the next claim builds it again.
 */
export const EXPORT_LEASE_SECONDS = 90;
export const EXPORT_HEARTBEAT_MS = 15_000;

/** Tables read at once. The rest wait their turn, which also spares the pool live traffic uses. */
const READERS = 4;
/** complete, fail and release still go while the server stops, for this long at most. */
const REPORT_TIMEOUT_MS = 5_000;

type Admin = ReturnType<typeof createAdminClient>;

const PAGE = 1000;

/**
 * Every row of a table for one restaurant. Stops only on an empty page, so a
 * server with a lower row limit than PAGE still gives all of them; throws once
 * the build stops.
 */
async function allRows<Row>(
  admin: Admin,
  table: keyof typeof COLUMNS,
  restaurantId: string,
  signal: AbortSignal,
  extra = '',
): Promise<Row[]> {
  const columns = [...COLUMNS[table], ...(extra ? [extra] : [])].join(', ');
  const rows: Row[] = [];
  let after: string | null = null;
  for (;;) {
    signal.throwIfAborted();
    let query = admin
      .from(table as 'orders')
      .select(columns)
      .eq('restaurant_id', restaurantId)
      .order('id')
      .limit(PAGE);
    if (after !== null) query = query.gt('id', after);
    const { data, error } = await query.abortSignal(signal);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = data as unknown as (Row & { id: string })[];
    if (page.length === 0) return rows;
    rows.push(...page);
    after = page.at(-1)!.id;
  }
}

/**
 * The readers, READERS at a time. The first to fail stops the others, as a stopped build does:
 * reads in flight are aborted and no more start. It throws only once every reader has ended, so
 * no read goes on after the build (review finding A2).
 */
async function readInTurns<T extends Record<string, (signal: AbortSignal) => Promise<unknown>>>(
  readers: T,
  signal: AbortSignal,
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const failed = new AbortController();
  const each = AbortSignal.any([signal, failed.signal]);
  const waiting = Object.entries(readers);
  const read: Record<string, unknown> = {};
  const errors: unknown[] = [];
  const reader = async () => {
    for (let next = waiting.shift(); next && !each.aborted; next = waiting.shift()) {
      const [name, readTable] = next;
      try {
        read[name] = await readTable(each);
      } catch (error) {
        errors.push(error);
        failed.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: READERS }, reader));
  signal.throwIfAborted();
  if (errors.length > 0) throw errors[0];
  return read as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

async function readExportData(
  admin: Admin,
  restaurantId: string,
  signal: AbortSignal,
): Promise<ExportData> {
  const restaurant = await admin
    .from('restaurants')
    .select(COLUMNS.restaurants.join(', '))
    .eq('id', restaurantId)
    .abortSignal(signal)
    .single();
  if (restaurant.error) throw new Error(`restaurants: ${restaurant.error.message}`);
  const subscription = await admin
    .from('restaurant_subscriptions')
    .select(
      [
        ...COLUMNS.restaurant_subscriptions,
        'plans!restaurant_subscriptions_plan_id_fkey (name)',
      ].join(', '),
    )
    .eq('restaurant_id', restaurantId)
    .abortSignal(signal)
    .maybeSingle();
  if (subscription.error) throw new Error(`subscription: ${subscription.error.message}`);

  const read =
    <Row>(table: keyof typeof COLUMNS, extra?: string) =>
    (each: AbortSignal) =>
      allRows<Row>(admin, table, restaurantId, each, extra);
  const rows = await readInTurns(
    {
      categories: read<ExportData['categories'][number]>('menu_categories'),
      items: read<ExportData['items'][number]>('menu_items'),
      variants: read<ExportData['variants'][number]>('menu_item_variants'),
      addonGroups: read<ExportData['addonGroups'][number]>(
        'menu_addon_groups',
        'menu_item_addon_groups (menu_item_id)',
      ),
      addons: read<ExportData['addons'][number]>('menu_addons'),
      tables: read<ExportData['tables'][number]>('dining_tables'),
      staff: read<ExportData['staff'][number]>('restaurant_members'),
      waiters: read<ExportData['waiters'][number]>('waiters'),
      sessions: read<ExportData['sessions'][number]>('table_sessions'),
      orders: read<ExportData['orders'][number]>('orders'),
      orderItems: read<ExportData['orderItems'][number]>('order_items'),
      bills: read<ExportData['bills'][number]>('bills'),
      billPayments: read<ExportData['billPayments'][number]>('bill_payments'),
      subscriptionPayments:
        read<ExportData['subscriptionPayments'][number]>('subscription_payments'),
    },
    signal,
  );

  return {
    restaurant: restaurant.data as unknown as ExportData['restaurant'],
    subscription: subscription.data as unknown as ExportData['subscription'],
    ...rows,
  };
}

/**
 * What one build may take of the heap: half of what this process was given, and at most
 * EXPORT_MEMORY_CAP. The process is shared by every restaurant and by the app's own work, and a
 * build holds about the estimate at its peak (docs/DECISIONS.md SA-93, VPS-6). The VPS sets
 * --max-old-space-size to about 65% of a web container's memory (VPS-24): about 1000 MB for web
 * (1536m), 500 MB for web-staging (768m). Node's heap_size_limit is that old space plus a young
 * generation of three semi-spaces, which Node sizes from the container's memory. Measured in the
 * image under those limits: 1096 MiB for web (semi-spaces of 32 MiB) and 548 MiB for web-staging
 * (16 MiB), so the limit is the cap on web and 274 MiB on web-staging.
 */
export const exportMemoryLimit = (heapLimit = getHeapStatistics().heap_size_limit) =>
  Math.min(EXPORT_MEMORY_CAP, Math.floor(heapLimit / 2));

const mib = (bytes: number) => Math.round(bytes / 2 ** 20);

/** How many rows the big tables hold, without reading them (HEAD with an exact count). */
async function rowCounts(
  admin: Admin,
  restaurantId: string,
  signal: AbortSignal,
): Promise<ExportCounts> {
  const tables = Object.keys(EXPORT_ROW_BYTES) as (keyof ExportCounts)[];
  const counted = await Promise.all(
    tables.map(async (table) => {
      const { count, error } = await admin
        .from(table as 'orders')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantId)
        .abortSignal(signal);
      if (error) throw new Error(`${table} count: ${error.message}`);
      return [table, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(counted) as ExportCounts;
}

/** How a build ended: built, failed, handed back to the queue, or its claim gone. */
export type ExportOutcome = 'ready' | 'failed' | 'released' | 'lost';

/**
 * Builds a claimed export's ZIP into the private bucket and says how it went (docs/DECISIONS.md
 * VPS-26). A heartbeat keeps the claim while it builds. An error fails the export, and the page
 * offers another try. When the server stops, the export goes back to the queue for the next one
 * to build. When the claim is gone (its lease ran out), the build stops and leaves the export to
 * whoever has it now. Every build of an export writes the same file.
 * ponytail: in memory and one upload, so an export past exportMemoryLimit() (about 37,000
 * bills on the VPS's web) fails before it starts. Stream it (deflate each file as it is
 * written, upload in parts) if a restaurant ever gets there.
 */
export async function buildExport(
  admin: Admin,
  claim: ExportClaim,
  run: JobRun,
): Promise<ExportOutcome> {
  const { exportId, restaurantId, claimId } = claim;
  const ids = { p_export_id: exportId, p_claim_id: claimId };
  const startedAt = Date.now();
  const gone = new AbortController();
  // The server stopping, or the claim gone, stops the build; the run's budget never does.
  const signal = AbortSignal.any([run.signal, gone.signal]);
  const heartbeat = async () => {
    try {
      const { data, error } = await admin
        .rpc('restaurant_export_heartbeat', { ...ids, p_lease_seconds: EXPORT_LEASE_SECONDS })
        .abortSignal(AbortSignal.timeout(REPORT_TIMEOUT_MS));
      if (error) throw error;
      if (!data) gone.abort(new DOMException('The export’s claim is gone', 'AbortError'));
    } catch (error) {
      // The lease outlasts a missed heartbeat or two.
      console.warn('[closure] export heartbeat failed', exportId, error);
    }
  };
  const beating = setInterval(heartbeat, EXPORT_HEARTBEAT_MS);
  let rows: number;
  let size: number;
  try {
    // One too big for this process fails here, before a row is read, as any other failed
    // build does (docs/DECISIONS.md SA-93, VPS-6).
    const counts = await rowCounts(admin, restaurantId, signal);
    const bytes = exportMemoryEstimate(counts);
    const limit = exportMemoryLimit();
    if (bytes > limit) {
      throw new Error(
        `too big to build in memory: about ${mib(bytes)} MiB for ${JSON.stringify(counts)}, over the ${mib(limit)} MiB allowed`,
      );
    }
    const now = new Date();
    const data = await readExportData(admin, restaurantId, signal);
    rows = Object.values(data).reduce<number>(
      (sum, value) => sum + (Array.isArray(value) ? value.length : 0),
      0,
    );
    const entries = [];
    for (const file of exportFiles(data, now)) {
      signal.throwIfAborted();
      entries.push(await zipEntry(file.name, file.text));
    }
    const archive = zipArchive(entries, now);
    // A claim gone by now uploads nothing. Once the upload starts the build finishes: the storage
    // client takes no signal.
    await heartbeat();
    signal.throwIfAborted();
    const uploaded = await admin.storage
      .from(EXPORT_BUCKET)
      .upload(`${restaurantId}/${exportId}.zip`, archive, {
        contentType: 'application/zip',
        upsert: true,
      });
    if (uploaded.error) throw new Error(`upload: ${uploaded.error.message}`);
    size = archive.length;
  } catch (error) {
    if (gone.signal.aborted) {
      console.warn('[closure] export claim lost', exportId);
      return 'lost';
    }
    if (run.signal.aborted) {
      const released = await admin
        .rpc('restaurant_export_release', ids)
        .abortSignal(AbortSignal.timeout(REPORT_TIMEOUT_MS));
      if (released.error)
        console.error('[closure] export not handed back', exportId, released.error);
      return 'released';
    }
    console.error('[closure] export failed', restaurantId, exportId, error);
    const failed = await admin
      .rpc('restaurant_export_fail', {
        ...ids,
        p_error: error instanceof Error ? error.message : String(error),
      })
      .abortSignal(AbortSignal.timeout(REPORT_TIMEOUT_MS));
    if (failed.error) console.error('[closure] export not marked', exportId, failed.error);
    return 'failed';
  } finally {
    clearInterval(beating);
  }

  const completed = await admin
    .rpc('restaurant_export_complete', { ...ids, p_size_bytes: size })
    .abortSignal(AbortSignal.timeout(REPORT_TIMEOUT_MS));
  if (completed.error) {
    // The ZIP is there but not offered. The lease runs out, and the export is built again.
    console.error('[closure] export not marked', exportId, completed.error);
    return 'lost';
  }
  if (!completed.data) {
    console.warn('[closure] export claim lost', exportId);
    return 'lost';
  }
  console.info('[closure] export ready', exportId, {
    rows,
    bytes: size,
    ms: Date.now() - startedAt,
  });
  return 'ready';
}
