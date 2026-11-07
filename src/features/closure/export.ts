import 'server-only';

import type { createAdminClient } from '@/lib/supabase/admin';
import { zipArchive, zipEntry } from '@/lib/zip';

import { COLUMNS, exportFiles, type ExportData } from './export-files';

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
 * Builds the ZIP into the private bucket and says how it went. Runs after the
 * response; a failure shows on the page, which offers another try.
 * ponytail: in memory and one upload; years of orders past the bucket's 50 MiB
 * fail visibly. Split the file, or upload it in parts, if one ever does.
 */
export async function buildExport(admin: Admin, restaurantId: string, exportId: string) {
  let size: number | null = null;
  try {
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
