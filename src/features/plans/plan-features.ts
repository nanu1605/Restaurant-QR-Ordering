/**
 * Plan limits and feature flags (spec §14.1–14.2). Pure helpers shared by
 * server and client; the data comes from restaurant_plan() (see queries.ts).
 * The database enforces the same rules (FEATURE_NOT_IN_PLAN, PLAN_LIMIT_*).
 */

export const FEATURE_KEYS = [
  'kds',
  'discounts',
  'split_payments',
  'upi_qr_on_bill',
  'advanced_reports',
  'waiter_reports',
  'csv_export',
  'remove_branding',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type PlanFeatures = {
  planCode: string;
  planName: string;
  /** null = unlimited */
  maxTables: number | null;
  /** Staff logins besides the owner; null = unlimited */
  maxStaff: number | null;
  features: Record<FeatureKey, boolean>;
};

/** Cheapest default plan that includes each feature, for upgrade hints. */
const FEATURE_PLAN: Record<FeatureKey, string> = {
  kds: 'Growth',
  discounts: 'Growth',
  split_payments: 'Growth',
  upi_qr_on_bill: 'Growth',
  advanced_reports: 'Growth',
  waiter_reports: 'Growth',
  csv_export: 'Growth',
  remove_branding: 'Pro',
};

const NO_FEATURES = Object.fromEntries(FEATURE_KEYS.map((key) => [key, false])) as Record<
  FeatureKey,
  boolean
>;

/** A restaurant without a subscription: nothing included (it is read-only anyway). */
export const NO_PLAN: PlanFeatures = {
  planCode: 'none',
  planName: 'No plan',
  maxTables: 0,
  maxStaff: 0,
  features: NO_FEATURES,
};

export type PlanRow = {
  plan_code: string;
  plan_name: string;
  max_tables: number | null;
  max_staff: number | null;
  features: unknown;
};

export function parsePlanFeatures(row: PlanRow | null | undefined): PlanFeatures {
  if (!row) return NO_PLAN;
  const raw = row.features && typeof row.features === 'object' ? row.features : {};
  const features = { ...NO_FEATURES };
  for (const key of FEATURE_KEYS) {
    features[key] = (raw as Record<string, unknown>)[key] === true;
  }
  return {
    planCode: row.plan_code,
    planName: row.plan_name,
    maxTables: row.max_tables,
    maxStaff: row.max_staff,
    features,
  };
}

export function hasFeature(plan: PlanFeatures, key: FeatureKey): boolean {
  return plan.features[key];
}

/** Short hint shown next to a locked feature, e.g. "Available on Growth". */
export function upgradeHint(key: FeatureKey): string {
  return `Available on ${FEATURE_PLAN[key]}`;
}

/** How many more fit under a limit (null limit = unlimited). */
export function remainingUnder(limit: number | null, used: number): number {
  return limit === null ? Number.POSITIVE_INFINITY : Math.max(0, limit - used);
}

/** "8 of 8 tables" with a limit, "12 tables" without. */
export function usageLabel(used: number, limit: number | null, noun: string, plural = `${noun}s`) {
  if (limit === null) return `${used} ${used === 1 ? noun : plural}`;
  return `${used} of ${limit} ${limit === 1 ? noun : plural}`;
}
