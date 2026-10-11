'use client';

import { cn } from 'cn';
import { Check } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Money } from '@/components/shared/money';
import { buttonVariants } from '@/components/ui/button';
import { FEATURE_KEYS } from '@/features/plans/plan-features';

import type { SiteContent } from '../content';
import { fill, fillNodes, plural } from '../i18n';
import { limitLabel, monthsFreeYearly, yearlySavingPaise, type SitePricing } from '../pricing';
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
export function PlanCards({
  t,
  pricing,
  signup,
}: {
  t: Pick<SiteContent, 'cta' | 'per'> &
    Pick<SiteContent['pricing'], 'cards' | 'blurbs' | 'limits' | 'everyPlan'> & {
      features: SiteContent['labels']['features'];
    };
  pricing: SitePricing;
  signup: boolean;
}) {
  const [cycle, setCycle] = useState<Cycle>('monthly');
  const monthsFree = monthsFreeYearly(pricing.plans);

  return (
    <div className="flex flex-col gap-6">
      <div
        role="group"
        aria-label={t.cards.cycle}
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
              cycle === value
                ? 'bg-primary text-primary-foreground ring-1 ring-brand ring-inset'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            {t.cards[value]}
            {value === 'yearly' && monthsFree > 0 && (
              <span className="ml-1.5 font-normal">· {plural(monthsFree, t.cards.monthsFree)}</span>
            )}
          </button>
        ))}
      </div>
      <h2 className="sr-only">{t.cards.plans}</h2>
      <ul aria-label={t.cards.plans} className="grid grid-cols-1 gap-5 md:grid-cols-3">
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
                <span className="absolute -top-3 left-6 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                  {fill(t.cards.trialBadge, { days: pricing.trialDays })}
                </span>
              )}
              <div className="flex flex-col gap-2">
                <h3 id={`plan-${plan.code}`} className="text-xl font-bold text-ink">
                  {plan.name}
                </h3>
                {t.blurbs[plan.code] && (
                  <p className="text-sm text-ink-muted">{t.blurbs[plan.code]}</p>
                )}
              </div>
              <p className="flex flex-wrap items-baseline gap-x-1.5 text-ink-muted">
                <span className="text-3xl font-bold text-ink">
                  <Money
                    paise={cycle === 'monthly' ? plan.monthlyPaise : plan.yearlyPaise}
                    fraction="auto"
                  />
                </span>{' '}
                {t.per[cycle]}
                {cycle === 'yearly' && saving > 0 && (
                  <span className="w-full text-sm font-semibold text-status-served">
                    {fillNodes(t.cards.save, { amount: <Money paise={saving} fraction="auto" /> })}
                  </span>
                )}
              </p>
              <ul className="flex flex-col gap-2 text-sm text-ink">
                <li className="font-semibold">{limitLabel(plan.maxTables, t.limits.tables)}</li>
                <li className="font-semibold">{limitLabel(plan.maxStaff, t.limits.staff)}</li>
                {builds ? (
                  <li className="pt-1 text-ink-muted">
                    {fill(shown.length > 0 ? t.cards.everythingPlus : t.cards.everything, {
                      plan: previous.name,
                    })}
                  </li>
                ) : (
                  t.everyPlan.map((text) => <Feature key={text} text={text} />)
                )}
                {shown.map((key) => (
                  <Feature key={key} text={t.features[key]} />
                ))}
              </ul>
              <Link
                data-cta="plan_card"
                href={
                  signup ? `/signup?plan=${plan.code}&cycle=${cycle}` : `/contact?plan=${plan.code}`
                }
                aria-label={
                  signup
                    ? fill(t.cards.signupLabel, { cta: t.cta.signup, plan: plan.name })
                    : fill(t.cards.demoLabel, { cta: t.cta.demo, plan: plan.name })
                }
                className={cn(
                  buttonVariants({ variant: trial ? 'default' : 'outline', size: 'touch' }),
                  'mt-auto',
                )}
              >
                {signup ? t.cta.signup : t.cta.demo}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
