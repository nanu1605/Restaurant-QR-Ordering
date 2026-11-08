import 'server-only';

import { getHeapStatistics } from 'node:v8';

import type { createAdminClient } from '@/lib/supabase/admin';
import { zipArchive, zipEntry } from '@/lib/zip';

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

type Admin = ReturnType<typeof createAdminClient>;

const PAGE = 1000;

/**
 * Every row of a table for one restaurant. Stops only on an empty page, so a
 * server with a lower row limit than PAGE still gives all of them.
 */
async function allRows<Row>(
  admin: Admin,
  table: keyof typeof COLUMNS,
  restaurantId: string,
  extra = '',
): Promise<Row[]> {
  const columns = [...COLUMNS[table], ...(extra ? [extra] : [])].join(', ');
  const rows: Row[] = [];
  let after: string | null = null;
  for (;;) {
    let query = admin
      .from(table as 'orders')
      .select(columns)
      .eq('restaurant_id', restaurantId)
      .order('id')
      .limit(PAGE);
    if (after !== null) query = query.gt('id', after);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = data as unknown as (Row & { id: string })[];
    if (page.length === 0) return rows;
    rows.push(...page);
    after = page.at(-1)!.id;
  }
}

async function readExportData(admin: Admin, restaurantId: string): Promise<ExportData> {
  const restaurant = await admin
    .from('restaurants')
    .select(COLUMNS.restaurants.join(', '))
    .eq('id', restaurantId)
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
    .maybeSingle();
  if (subscription.error) throw new Error(`subscription: ${subscription.error.message}`);

  const read = <Row>(table: keyof typeof COLUMNS, extra?: string) =>
    allRows<Row>(admin, table, restaurantId, extra);
  const [
    categories,
    items,
    variants,
    addonGroups,
    addons,
    tables,
    staff,
    waiters,
    sessions,
    orders,
    orderItems,
    bills,
    billPayments,
    subscriptionPayments,
  ] = await Promise.all([
    read<ExportData['categories'][number]>('menu_categories'),
    read<ExportData['items'][number]>('menu_items'),
    read<ExportData['variants'][number]>('menu_item_variants'),
    read<ExportData['addonGroups'][number]>(
      'menu_addon_groups',
      'menu_item_addon_groups (menu_item_id)',
    ),
    read<ExportData['addons'][number]>('menu_addons'),
    read<ExportData['tables'][number]>('dining_tables'),
    read<ExportData['staff'][number]>('restaurant_members'),
    read<ExportData['waiters'][number]>('waiters'),
    read<ExportData['sessions'][number]>('table_sessions'),
    read<ExportData['orders'][number]>('orders'),
    read<ExportData['orderItems'][number]>('order_items'),
    read<ExportData['bills'][number]>('bills'),
    read<ExportData['billPayments'][number]>('bill_payments'),
    read<ExportData['subscriptionPayments'][number]>('subscription_payments'),
  ]);

  return {
    restaurant: restaurant.data as unknown as ExportData['restaurant'],
    subscription: subscription.data as unknown as ExportData['subscription'],
    categories,
    items,
    variants,
    addonGroups,
    addons,
    tables,
    staff,
    waiters,
    sessions,
    orders,
    orderItems,
    bills,
    billPayments,
    subscriptionPayments,
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
async function rowCounts(admin: Admin, restaurantId: string): Promise<ExportCounts> {
  const tables = Object.keys(EXPORT_ROW_BYTES) as (keyof ExportCounts)[];
  const counted = await Promise.all(
    tables.map(async (table) => {
      const { count, error } = await admin
        .from(table as 'orders')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantId);
      if (error) throw new Error(`${table} count: ${error.message}`);
      return [table, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(counted) as ExportCounts;
}

/**
 * Builds the ZIP into the private bucket and says how it went. Runs after the
 * response; a failure shows on the page, which offers another try.
 * ponytail: in memory and one upload, so an export past exportMemoryLimit() (about 37,000
 * bills on the VPS's web) fails before it starts. Stream it (deflate each file as it is
 * written, upload in parts) if a restaurant ever gets there.
 */
export async function buildExport(admin: Admin, restaurantId: string, exportId: string) {
  let size: number | null = null;
  try {
    // One too big for this process fails here, before a row is read, as any other failed
    // build does (docs/DECISIONS.md SA-93, VPS-6).
    const counts = await rowCounts(admin, restaurantId);
    const bytes = exportMemoryEstimate(counts);
    const limit = exportMemoryLimit();
    if (bytes > limit) {
      throw new Error(
        `too big to build in memory: about ${mib(bytes)} MiB for ${JSON.stringify(counts)}, over the ${mib(limit)} MiB allowed`,
      );
    }
    const now = new Date();
    const data = await readExportData(admin, restaurantId);
    const entries = [];
    for (const file of exportFiles(data, now)) entries.push(await zipEntry(file.name, file.text));
    const archive = zipArchive(entries, now);
    const uploaded = await admin.storage
      .from(EXPORT_BUCKET)
      .upload(`${restaurantId}/${exportId}.zip`, archive, { contentType: 'application/zip' });
    if (uploaded.error) throw new Error(`upload: ${uploaded.error.message}`);
    size = archive.length;
  } catch (error) {
    console.error('[closure] export failed', restaurantId, exportId, error);
  }
  const finished = await admin.rpc('restaurant_export_finish', {
    p_export_id: exportId,
    ...(size === null ? {} : { p_size_bytes: size }),
  });
  if (finished.error) console.error('[closure] export not marked', exportId, finished.error);
}
