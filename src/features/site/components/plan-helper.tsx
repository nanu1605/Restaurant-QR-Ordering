'use client';

import { cn } from 'cn';
import Link from 'next/link';
import { useId, useState } from 'react';

import { Money } from '@/components/shared/money';
import { buttonVariants } from '@/components/ui/button';
import { FEATURE_KEYS, FEATURE_LABELS, type FeatureKey } from '@/features/plans/plan-features';

import { HERO, SIGNUP_CTA } from '../content';
import { recommendPlan, staffLabel, tablesLabel, type PricingPlan } from '../pricing';

const MAX_TABLES = 60;
const MAX_STAFF = 40;

/** "Which plan fits me?": a few questions, answered with the real plan limits. */
export function PlanHelper({ plans, signup }: { plans: PricingPlan[]; signup: boolean }) {
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
          label="Tables with a QR code"
          value={tables}
          max={MAX_TABLES}
          onChange={setTables}
        />
        <Range
          id={`${id}-staff`}
          label="Staff who sign in (not counting you)"
          value={staff}
          min={0}
          max={MAX_STAFF}
          onChange={setStaff}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-semibold text-ink">I also want</legend>
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
                {FEATURE_LABELS[key]}
              </label>
            ))}
          </div>
        </fieldset>
      </form>
      <div
        role="status"
        aria-label="Recommended plan"
        className="flex flex-col justify-center gap-4 rounded-2xl bg-surface p-6 text-center shadow-sm"
      >
        {plan ? (
          <>
            <p className="text-sm font-semibold text-ink-muted">Your best fit</p>
            <p className="text-3xl font-bold text-ink">{plan.name}</p>
            <p className="text-ink-muted">
              <Money paise={plan.monthlyPaise} fraction="auto" className="font-semibold text-ink" />{' '}
              a month
            </p>
            <p className="text-sm text-ink-muted">
              {tablesLabel(plan.maxTables)} · {staffLabel(plan.maxStaff)}
            </p>
          </>
        ) : (
          <>
            <p className="text-xl font-bold text-ink">Let’s talk</p>
            <p className="text-sm text-ink-muted">
              That’s more than our plans cover today. Tell us about your restaurant and we’ll work
              it out with you.
            </p>
          </>
        )}
        {/* "Let's talk" stays a conversation, even when visitors can sign up. */}
        <Link
          href={
            plan
              ? signup
                ? `/signup?plan=${plan.code}`
                : `/contact?plan=${plan.code}`
              : '/contact'
          }
          className={cn(buttonVariants({ size: 'touch' }), 'self-center px-6')}
        >
          {plan && signup ? SIGNUP_CTA : HERO.primary}
        </Link>
      </div>
    </div>
  );
}

function Range({
  id,
  label,
  value,
  min = 1,
  max,
  onChange,
}: {
  id: string;
  label: string;
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
        aria-valuetext={value === max ? `${max} or more` : undefined}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-11 w-full cursor-pointer accent-brand"
      />
    </div>
  );
}
