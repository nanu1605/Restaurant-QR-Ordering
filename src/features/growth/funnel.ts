import { z } from 'zod';

import { ACQUISITION_CHANNELS, SUBSCRIPTION_STATES } from '@/features/platform/platform';

/** The funnel, channels, sources and upgrade opportunities (docs/DECISIONS.md SA-58 to SA-60). */

const funnelSchema = z.object({
  from: z.string(),
  to: z.string(),
  demo_requests: z.number(),
  /** Null when no day in the range has a count. */
  signups_started: z.number().nullable(),
  /** Set when the range starts before the counts do. */
  signups_counted_from: z.string().nullable(),
  cohort: z.array(
    z.object({
      kind: z.enum(['signup', 'team']),
      created: z.number(),
      first_order: z.number(),
      first_payment: z.number(),
    }),
  ),
  channels: z.array(
    z.object({
      channel: z.enum([...ACQUISITION_CHANNELS, 'unknown']),
      leads: z.number(),
      restaurants: z.number(),
      paying: z.number(),
      mrr_paise: z.number(),
    }),
  ),
  sources: z.array(
    z.object({
      utm_source: z.string().nullable(),
      referrer: z.string().nullable(),
      demo_requests: z.number(),
      signups: z.number(),
      paying: z.number(),
    }),
  ),
  other_sources: z
    .object({
      count: z.number(),
      demo_requests: z.number(),
      signups: z.number(),
      paying: z.number(),
    })
    .nullable(),
});
export type Funnel = z.infer<typeof funnelSchema>;
export const parseFunnel = (json: unknown) => funnelSchema.parse(json);

/**
 * A part of a whole, honest with small numbers (docs/SUPER_ADMIN_PLAN.md §1):
 * "2 of 3" below 5, else "430 of 612, 70%"; a dash when there is no whole.
 */
export function formatShare(part: number, whole: number): string {
  if (whole === 0) return '—';
  const fraction = `${part.toLocaleString('en-IN')} of ${whole.toLocaleString('en-IN')}`;
  return whole < 5 ? fraction : `${fraction}, ${Math.round((part / whole) * 100)}%`;
}

/** Where website arrivals came from: the utm source, else the site that linked. */
export function sourceLabel(source: { utm_source: string | null; referrer: string | null }) {
  if (source.utm_source) return source.utm_source;
  if (source.referrer) return `From ${source.referrer}`;
  return 'Direct or not known';
}

const upgradesSchema = z.object({
  busy_orders: z.number(),
  rows: z.array(
    z.object({
      restaurant_id: z.string(),
      name: z.string(),
      slug: z.string(),
      city: z.string().nullable(),
      phone: z.string().nullable(),
      state: z.enum(SUBSCRIPTION_STATES),
      tables: z.number(),
      max_tables: z.number().nullable(),
      staff: z.number(),
      max_staff: z.number().nullable(),
      orders: z.number(),
      hits: z.array(
        z.object({
          kind: z.enum(['tables', 'staff', 'feature']),
          feature: z.string().nullable(),
          count: z.number(),
        }),
      ),
    }),
  ),
});
export type UpgradeOpportunities = z.infer<typeof upgradesSchema>;
export const parseUpgrades = (json: unknown) => upgradesSchema.parse(json);
