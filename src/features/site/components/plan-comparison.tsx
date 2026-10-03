import { Check, Minus } from 'lucide-react';

import { FEATURE_KEYS, FEATURE_LABELS } from '@/features/plans/plan-features';

import { PRICING } from '../content';
import type { PricingPlan } from '../pricing';
import { WithHindi } from './with-hindi';

function Yes({ plan }: { plan: string }) {
  return (
    <>
      <Check aria-hidden className="mx-auto size-5 text-status-served" />
      <span className="sr-only">Included in {plan}</span>
    </>
  );
}

/** "Unlimited", drawn as ∞ where the phone's columns are narrow. */
function Limit({ value }: { value: number | null }) {
  if (value !== null) return value;
  return (
    <>
      <span aria-hidden className="text-lg sm:hidden">
        ∞
      </span>
      <span className="max-sm:sr-only">Unlimited</span>
    </>
  );
}

function No({ plan }: { plan: string }) {
  return (
    <>
      <Minus aria-hidden className="mx-auto size-5 text-ink-muted/60" />
      <span className="sr-only">Not in {plan}</span>
    </>
  );
}

/** Every plan's limits and features in one table, from the same data as the cards. */
export function PlanComparison({ plans }: { plans: PricingPlan[] }) {
  const cell = 'w-16 px-1 py-3 text-center sm:w-36 sm:px-4';
  const head = 'px-3 py-3 text-left font-normal text-ink sm:px-4';
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table className="w-full text-sm">
        <caption className="sr-only">What each plan includes</caption>
        <thead>
          <tr className="border-b border-line">
            <td className="px-3 py-3 sm:px-4" />
            {plans.map((plan) => (
              <th key={plan.code} scope="col" className={`${cell} font-bold text-ink sm:text-base`}>
                {plan.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          <tr>
            <th scope="row" className={head}>
              Tables
            </th>
            {plans.map((plan) => (
              <td key={plan.code} className={`${cell} font-semibold text-ink`}>
                <Limit value={plan.maxTables} />
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className={head}>
              Staff logins
            </th>
            {plans.map((plan) => (
              <td key={plan.code} className={`${cell} font-semibold text-ink`}>
                <Limit value={plan.maxStaff} />
              </td>
            ))}
          </tr>
          {PRICING.everyPlan.map((feature) => (
            <tr key={feature}>
              <th scope="row" className={head}>
                <WithHindi text={feature} />
              </th>
              {plans.map((plan) => (
                <td key={plan.code} className={cell}>
                  <Yes plan={plan.name} />
                </td>
              ))}
            </tr>
          ))}
          {FEATURE_KEYS.map((key) => (
            <tr key={key}>
              <th scope="row" className={head}>
                {FEATURE_LABELS[key]}
              </th>
              {plans.map((plan) => (
                <td key={plan.code} className={cell}>
                  {plan.features[key] ? <Yes plan={plan.name} /> : <No plan={plan.name} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
