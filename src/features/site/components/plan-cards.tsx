'use client';

import { cn } from 'cn';
import { Check } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Money } from '@/components/shared/money';
import { buttonVariants } from '@/components/ui/button';
import { FEATURE_KEYS, FEATURE_LABELS } from '@/features/plans/plan-features';

import { HERO, PRICING } from '../content';
import {
  monthsFreeYearly,
  staffLabel,
  tablesLabel,
  yearlySavingPaise,
  type SitePricing,
} from '../pricing';
import { WithHindi } from './with-hindi';

type Cycle = 'monthly' | 'yearly';

function Feature({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2">
      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-status-served" />
      <span>
        <WithHindi text={text} />
      </span>
    </li>
  );
}

/** The plans side by side, with a monthly / yearly switch. */
export function PlanCards({ pricing }: { pricing: SitePricing }) {
  const [cycle, setCycle] = useState<Cycle>('monthly');
  const monthsFree = monthsFreeYearly(pricing.plans);

  return (
    <div className="flex flex-col gap-6">
      <div
        role="group"
        aria-label="Billing cycle"
        className="flex self-center rounded-full border border-line bg-surface p-1"
      >
        {(['monthly', 'yearly'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={cycle === value}
            onClick={() => setCycle(value)}
            className={cn(
              'h-11 rounded-full px-5 text-sm font-semibold transition-colors',
              cycle === value ? 'bg-brand text-white' : 'text-ink-muted hover:text-ink',
            )}
          >
            {value === 'monthly' ? 'Monthly' : 'Yearly'}
            {value === 'yearly' && monthsFree > 0 && (
              <span className="ml-1.5 font-normal">
                · {monthsFree} {monthsFree === 1 ? 'month' : 'months'} free
              </span>
            )}
          </button>
        ))}
      </div>
      <h2 className="sr-only">Plans</h2>
      <ul aria-label="Plans" className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {pricing.plans.map((plan, index) => {
          const trial = plan.code === pricing.trialPlanCode;
          const saving = yearlySavingPaise(plan);
          // Each plan lists what it adds to the one before, when it has all of that one's.
          const previous = pricing.plans[index - 1];
          const builds =
            previous !== undefined &&
            FEATURE_KEYS.every((key) => !previous.features[key] || plan.features[key]);
          const shown = FEATURE_KEYS.filter(
            (key) => plan.features[key] && !(builds && previous.features[key]),
          );
          return (
            <li
              key={plan.code}
              aria-labelledby={`plan-${plan.code}`}
              className={cn(
                'relative flex flex-col gap-5 rounded-2xl border bg-surface p-6',
                trial ? 'border-brand shadow-lg shadow-brand/10' : 'border-line',
              )}
            >
              {trial && (
                <span className="absolute -top-3 left-6 rounded-full bg-brand px-3 py-1 text-xs font-semibold text-white">
                  Free for {pricing.trialDays} days
                </span>
              )}
              <div className="flex flex-col gap-2">
                <h3 id={`plan-${plan.code}`} className="text-xl font-bold text-ink">
                  {plan.name}
                </h3>
                {PRICING.blurbs[plan.code] && (
                  <p className="text-sm text-ink-muted">{PRICING.blurbs[plan.code]}</p>
                )}
              </div>
              <p className="flex flex-wrap items-baseline gap-x-1.5 text-ink-muted">
                <span className="text-3xl font-bold text-ink">
                  <Money
                    paise={cycle === 'monthly' ? plan.monthlyPaise : plan.yearlyPaise}
                    fraction="auto"
                  />
                </span>{' '}
                {cycle === 'monthly' ? 'a month' : 'a year'}
                {cycle === 'yearly' && saving > 0 && (
                  <span className="w-full text-sm font-semibold text-status-served">
                    You save <Money paise={saving} fraction="auto" />
                  </span>
                )}
              </p>
              <ul className="flex flex-col gap-2 text-sm text-ink">
                <li className="font-semibold">{tablesLabel(plan.maxTables)}</li>
                <li className="font-semibold">{staffLabel(plan.maxStaff)}</li>
                {builds ? (
                  <li className="pt-1 text-ink-muted">
                    Everything in {previous.name}
                    {shown.length > 0 ? ', plus:' : ''}
                  </li>
                ) : (
                  PRICING.everyPlan.map((text) => <Feature key={text} text={text} />)
                )}
                {shown.map((key) => (
                  <Feature key={key} text={FEATURE_LABELS[key]} />
                ))}
              </ul>
              <Link
                href={`/contact?plan=${plan.code}`}
                aria-label={`${HERO.primary} for the ${plan.name} plan`}
                className={cn(
                  buttonVariants({ variant: trial ? 'default' : 'outline', size: 'touch' }),
                  'mt-auto',
                )}
              >
                {HERO.primary}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
