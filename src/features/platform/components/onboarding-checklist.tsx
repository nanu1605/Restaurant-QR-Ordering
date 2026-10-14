import { cn } from 'cn';
import { CircleCheck, Circle } from 'lucide-react';

import {
  ONBOARDING_STEP_LABELS,
  ONBOARDING_STEPS,
  type Onboarding,
} from '@/features/onboarding/onboarding';
import { formatShortDate } from '@/features/platform/platform';

import { Section } from './restaurant-sections';
import { StuckBadge } from './status-badges';

/** The seven setup steps on a restaurant's Overview (docs/DECISIONS.md SA-41). */
export function OnboardingChecklist({ onboarding }: { onboarding: Onboarding }) {
  const { done, next, stuck, since, steps } = onboarding;
  return (
    <Section
      title="Onboarding"
      action={
        <span className="text-sm text-ink-muted tabular-nums">
          {done} of {ONBOARDING_STEPS.length} done
        </span>
      }
    >
      {next !== null && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink">
          <span>
            Next: <span className="font-semibold">{ONBOARDING_STEP_LABELS[next]}</span>
          </span>
          {stuck && <StuckBadge since={since} />}
        </p>
      )}
      <ol className="flex flex-col gap-1.5 text-sm">
        {steps.map((step) => {
          const Icon = step.done_at ? CircleCheck : Circle;
          return (
            <li key={step.key} className="flex items-start gap-2">
              <Icon
                aria-hidden
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  step.done_at ? 'text-status-served' : 'text-ink-muted',
                )}
              />
              <span className={cn('flex-1', step.key === next && 'font-semibold')}>
                {ONBOARDING_STEP_LABELS[step.key]}
                <span className="sr-only">{step.done_at ? ' (done)' : ' (to do)'}</span>
              </span>
              {step.done_at && (
                <span className="text-ink-muted tabular-nums">{formatShortDate(step.done_at)}</span>
              )}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
