'use client';

import { cn } from 'cn';
import { useId, useState } from 'react';

import { Money } from '@/components/shared/money';
import { buttonVariants } from '@/components/ui/button';
import { FEATURE_KEYS, type FeatureKey } from '@/features/plans/plan-features';

import type { SiteContent, SiteLang } from '../content';
import { fill } from '../i18n';
import { limitLabel, recommendPlan, type PricingPlan } from '../pricing';
import { SiteLink } from './site-link';

const MAX_TABLES = 60;
const MAX_STAFF = 40;

/** "Which plan fits me?": a few questions, answered with the real plan limits. */
export function PlanHelper({
  siteLang,
  t,
  plans,
  signup,
}: {
  siteLang: SiteLang;
  t: Pick<SiteContent, 'cta' | 'per'> &
    Pick<SiteContent['pricing'], 'helper' | 'limits'> & {
      features: SiteContent['labels']['features'];
    };
  plans: PricingPlan[];
  signup: boolean;
}) {
  const [tables, setTables] = useState(8);
  const [staff, setStaff] = useState(3);
  const [features, setFeatures] = useState<FeatureKey[]>([]);
  const id = useId();
  const plan = recommendPlan(plans, { tables, staff, features });

  function toggle(key: FeatureKey, on: boolean) {
    setFeatures((current) => (on ? [...current, key] : current.filter((item) => item !== key)));
  }

  return (
    <div className="grid grid-cols-1 gap-8 rounded-3xl border border-line bg-paper p-6 sm:p-8 lg:grid-cols-[1.4fr_1fr]">
      <form className="flex min-w-0 flex-col gap-6" onSubmit={(event) => event.preventDefault()}>
        <Range
          id={`${id}-tables`}
          label={t.helper.tables}
          orMore={t.helper.orMore}
          value={tables}
          max={MAX_TABLES}
          onChange={setTables}
        />
        <Range
          id={`${id}-staff`}
          label={t.helper.staff}
          orMore={t.helper.orMore}
          value={staff}
          min={0}
          max={MAX_STAFF}
          onChange={setStaff}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-semibold text-ink">{t.helper.features}</legend>
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {FEATURE_KEYS.map((key) => (
              <label
                key={key}
                className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-ink"
              >
                <input
                  type="checkbox"
                  checked={features.includes(key)}
                  onChange={(event) => toggle(key, event.target.checked)}
                  className="size-5 shrink-0 accent-brand"
                />
                {t.features[key]}
              </label>
            ))}
          </div>
        </fieldset>
      </form>
      <div
        role="status"
        aria-label={t.helper.result}
        className="flex flex-col justify-center gap-4 rounded-2xl bg-surface p-6 text-center shadow-sm"
      >
        {plan ? (
          <>
            <p className="text-sm font-semibold text-ink-muted">{t.helper.bestFit}</p>
            <p className="text-3xl font-bold text-ink">{plan.name}</p>
            <p className="text-ink-muted">
              <Money paise={plan.monthlyPaise} fraction="auto" className="font-semibold text-ink" />{' '}
              {t.per.monthly}
            </p>
            <p className="text-sm text-ink-muted">
              {limitLabel(plan.maxTables, t.limits.tables)} ·{' '}
              {limitLabel(plan.maxStaff, t.limits.staff)}
            </p>
          </>
        ) : (
          <>
            <p className="text-xl font-bold text-ink">{t.helper.talk}</p>
            <p className="text-sm text-ink-muted">{t.helper.tooBig}</p>
          </>
        )}
        {/* "Let's talk" stays a conversation, even when visitors can sign up. */}
        <SiteLink
          siteLang={siteLang}
          data-cta="plan_finder"
          href={
            plan
              ? signup
                ? `/signup?plan=${plan.code}`
                : `/contact?plan=${plan.code}`
              : '/contact'
          }
          className={cn(buttonVariants({ size: 'touch' }), 'self-center px-6')}
        >
          {plan && signup ? t.cta.signup : t.cta.demo}
        </SiteLink>
      </div>
    </div>
  );
}

function Range({
  id,
  label,
  orMore,
  value,
  min = 1,
  max,
  onChange,
}: {
  id: string;
  label: string;
  /** "{n} or more", read out at the top of the scale. */
  orMore: string;
  value: number;
  min?: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-semibold text-ink">
          {label}
        </label>
        <span aria-hidden className="text-2xl font-bold text-brand tabular-nums">
          {value === max ? `${max}+` : value}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        value={value}
        aria-valuetext={value === max ? fill(orMore, { n: max }) : undefined}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-11 w-full cursor-pointer accent-brand"
      />
    </div>
  );
}
