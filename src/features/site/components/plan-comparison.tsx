import { Check, Minus } from 'lucide-react';

import { FEATURE_KEYS } from '@/features/plans/plan-features';

import { SITE, type SiteLang } from '../content';
import { fill } from '../i18n';
import type { PricingPlan } from '../pricing';
import { WithHindi } from './with-hindi';

function Yes({ label }: { label: string }) {
  return (
    <>
      <Check aria-hidden className="mx-auto size-5 text-status-served" />
      <span className="sr-only">{label}</span>
    </>
  );
}

/** "Unlimited", drawn as ∞ where the phone's columns are narrow. */
function Limit({ value, unlimited }: { value: number | null; unlimited: string }) {
  if (value !== null) return value;
  return (
    <>
      <span aria-hidden className="text-lg sm:hidden">
        ∞
      </span>
      <span className="max-sm:sr-only">{unlimited}</span>
    </>
  );
}

function No({ label }: { label: string }) {
  return (
    <>
      <Minus aria-hidden className="mx-auto size-5 text-ink-muted/60" />
      <span className="sr-only">{label}</span>
    </>
  );
}

/** Every plan's limits and features in one table, from the same data as the cards. */
export function PlanComparison({ lang, plans }: { lang: SiteLang; plans: PricingPlan[] }) {
  const t = SITE[lang];
  const words = t.pricing.compare;
  const cell = 'w-16 px-1 py-3 text-center sm:w-36 sm:px-4';
  const head = 'px-3 py-3 text-left font-normal text-ink sm:px-4';
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table className="w-full text-sm">
        <caption className="sr-only">{words.caption}</caption>
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
              {words.tables}
            </th>
            {plans.map((plan) => (
              <td key={plan.code} className={`${cell} font-semibold text-ink`}>
                <Limit value={plan.maxTables} unlimited={words.unlimited} />
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className={head}>
              {words.staff}
            </th>
            {plans.map((plan) => (
              <td key={plan.code} className={`${cell} font-semibold text-ink`}>
                <Limit value={plan.maxStaff} unlimited={words.unlimited} />
              </td>
            ))}
          </tr>
          {t.pricing.everyPlan.map((feature) => (
            <tr key={feature}>
              <th scope="row" className={head}>
                <WithHindi text={feature} />
              </th>
              {plans.map((plan) => (
                <td key={plan.code} className={cell}>
                  <Yes label={fill(words.included, { plan: plan.name })} />
                </td>
              ))}
            </tr>
          ))}
          {FEATURE_KEYS.map((key) => (
            <tr key={key}>
              <th scope="row" className={head}>
                {t.labels.features[key]}
              </th>
              {plans.map((plan) => (
                <td key={plan.code} className={cell}>
                  {plan.features[key] ? (
                    <Yes label={fill(words.included, { plan: plan.name })} />
                  ) : (
                    <No label={fill(words.notIncluded, { plan: plan.name })} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
