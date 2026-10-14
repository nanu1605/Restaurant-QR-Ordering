/**
 * Fills metrics_usage_daily for past business days (docs/SUPER_ADMIN_PLAN.md
 * §4.1, docs/DECISIONS.md SA-10). Run once per environment after the 12b
 * migration; the daily cron keeps it up to date afterwards. Safe to run again:
 * each day is recounted. Uses the Supabase URL and secret key from .env.local.
 *
 *   pnpm metrics:backfill [--from 2026-09-01] [--to 2026-10-14]
 *
 * Without --from it starts at the first order.
 */
import { parseArgs } from 'node:util';

import { createClient } from '@supabase/supabase-js';

import type { Database } from '../src/types/database.ts';

// Each call is one transaction under the API's statement timeout: short ranges.
const CHUNK_DAYS = 14;

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const indiaDate = (at: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(at);
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const { values: args } = parseArgs({
  options: { from: { type: 'string' }, to: { type: 'string' } },
  strict: true,
});

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
if (!supabaseUrl || !secretKey) {
  fail('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env.local.');
}
const admin = createClient<Database>(supabaseUrl, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let from = args.from;
if (!from) {
  const { data, error } = await admin
    .from('orders')
    .select('created_at')
    .order('created_at')
    .limit(1)
    .maybeSingle();
  if (error) fail(`Could not find the first order: ${error.message}`);
  if (!data) {
    console.log('No orders yet: nothing to backfill.');
    process.exit(0);
  }
  // The day before, for an order placed before the business day's start hour.
  from = addDays(indiaDate(new Date(data.created_at)), -1);
}
const to = args.to ?? indiaDate(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
  fail('--from and --to are dates (YYYY-MM-DD), --from first.');
}

console.log(`Backfilling usage ${from} to ${to} on ${supabaseUrl} …`);
let rows = 0;
for (let start = from; start <= to; start = addDays(start, CHUNK_DAYS)) {
  const end = [addDays(start, CHUNK_DAYS - 1), to].sort()[0]!;
  const { data, error } = await admin.rpc('platform_metrics_backfill_usage', {
    p_from: start,
    p_to: end,
  });
  if (error) fail(`${start} to ${end}: ${error.message}`);
  rows += data;
  console.log(`  ${start} to ${end}: ${data} restaurant days`);
}
console.log(`✔ ${rows} restaurant days stored.`);
