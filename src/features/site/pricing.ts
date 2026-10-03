import { FEATURE_KEYS, type FeatureKey } from '@/features/plans/plan-features';
import type { Paise } from '@/lib/money';

/**
 * The pricing page's plans (docs/DECISIONS.md W-5): read from the `plans`
 * table, so the site always shows what /super set. Pure helpers, shared by
 * the server page and the client cards.
 */

export type PricingPlan = {
  code: string;
  name: string;
  monthlyPaise: Paise;
  yearlyPaise: Paise;
  /** null = unlimited */
  maxTables: number | null;
  /** Staff logins besides the owner; null = unlimited */
  maxStaff: number | null;
  features: Record<FeatureKey, boolean>;
};

export type SitePricing = {
  plans: PricingPlan[];
  trialDays: number;
  /** New restaurants trial this plan (spec §14.1). */
  trialPlanCode: string;
  setupFeePaise: Paise;
};

export type PlanRow = {
  code: string;
  name: string;
  price_monthly_paise: number;
  price_yearly_paise: number;
  max_tables: number | null;
  max_staff: number | null;
  features: unknown;
};

export function toPricingPlan(row: PlanRow): PricingPlan {
  const raw = (row.features ?? {}) as Record<string, unknown>;
  return {
    code: row.code,
    name: row.name,
    monthlyPaise: row.price_monthly_paise,
    yearlyPaise: row.price_yearly_paise,
    maxTables: row.max_tables,
    maxStaff: row.max_staff,
    features: Object.fromEntries(FEATURE_KEYS.map((key) => [key, raw[key] === true])) as Record<
      FeatureKey,
      boolean
    >,
  };
}

/** What a year costs less than twelve months, never below zero. */
export function yearlySavingPaise(plan: PricingPlan): Paise {
  return Math.max(0, plan.monthlyPaise * 12 - plan.yearlyPaise);
}

/** Whole months saved by paying yearly that every paid plan offers (0 if any plan offers none). */
export function monthsFreeYearly(plans: PricingPlan[]): number {
  const paid = plans.filter((plan) => plan.monthlyPaise > 0);
  if (paid.length === 0) return 0;
  return Math.min(...paid.map((plan) => Math.floor(yearlySavingPaise(plan) / plan.monthlyPaise)));
}

export type PlanNeeds = { tables: number; staff: number; features: FeatureKey[] };

export function planFits(plan: PricingPlan, needs: PlanNeeds): boolean {
  return (
    (plan.maxTables === null || plan.maxTables >= needs.tables) &&
    (plan.maxStaff === null || plan.maxStaff >= needs.staff) &&
    needs.features.every((key) => plan.features[key])
  );
}

/** The cheapest plan that fits, or null when none does. */
export function recommendPlan(plans: PricingPlan[], needs: PlanNeeds): PricingPlan | null {
  return (
    plans
      .filter((plan) => planFits(plan, needs))
      .sort((a, b) => a.monthlyPaise - b.monthlyPaise)[0] ?? null
  );
}

export function tablesLabel(max: number | null): string {
  return max === null ? 'Unlimited tables' : `Up to ${max} tables`;
}

export function staffLabel(max: number | null): string {
  return max === null ? 'Unlimited staff logins' : `Up to ${max} staff logins`;
}
