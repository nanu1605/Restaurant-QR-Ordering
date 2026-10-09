'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { attributionField } from '@/features/analytics/attribution';
import { CUISINE_LABELS, CUISINE_SETS, DEFAULT_CUISINE } from '@/features/menu/default-categories';

import { startSignup, type SignupFormState } from '../signup-actions';
import { Field, SELECT_CLASS } from './contact-form';
import { TurnstileWidget } from './turnstile-widget';

type State = { result: SignupFormState; round: number };

/** Step 1 of the self-serve signup (docs/DECISIONS.md W-9); a success moves on to /signup/verify. */
export function SignupForm({
  siteKey,
  planCode,
  cycle,
}: {
  siteKey: string;
  planCode: string;
  cycle: string;
}) {
  const [{ result, round }, action, pending] = useActionState(
    async (previous: State, formData: FormData): Promise<State> => ({
      result: await startSignup(previous.result, attributionField(formData)),
      round: previous.round + 1,
    }),
    { result: null, round: 0 },
  );
  const [checked, setChecked] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const cuisineId = useId();
  const termsId = useId();

  // After a refusal, focus the first field to fix (its message is linked to it).
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [result]);

  const value = (field: keyof NonNullable<SignupFormState>['values']) =>
    result?.values[field] ?? '';
  const error = (field: keyof NonNullable<SignupFormState>['values']) =>
    result?.fieldErrors?.[field];

  return (
    <form
      ref={form}
      action={action}
      noValidate
      aria-label="Start your free trial"
      className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-4 sm:p-8"
    >
      <input type="hidden" name="planCode" value={planCode} />
      <input type="hidden" name="cycle" value={cycle} />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field
          name="restaurantName"
          label="Restaurant name"
          autoComplete="organization"
          defaultValue={value('restaurantName')}
          error={error('restaurantName')}
        />
        <Field
          name="city"
          label="City"
          autoComplete="address-level2"
          defaultValue={value('city')}
          error={error('city')}
        />
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={cuisineId}>Menu style</Label>
          <select
            key={value('cuisine')}
            id={cuisineId}
            name="cuisine"
            defaultValue={value('cuisine') || DEFAULT_CUISINE}
            aria-describedby={`${cuisineId}-hint`}
            className={SELECT_CLASS}
          >
            {CUISINE_SETS.map((cuisine) => (
              <option key={cuisine} value={cuisine}>
                {CUISINE_LABELS[cuisine]}
              </option>
            ))}
          </select>
          <p id={`${cuisineId}-hint`} className="text-sm text-ink-muted">
            Your menu starts with matching categories.
          </p>
        </div>
        <Field
          name="ownerName"
          label="Your name"
          autoComplete="name"
          defaultValue={value('ownerName')}
          error={error('ownerName')}
        />
        <Field
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          defaultValue={value('email')}
          error={error('email')}
        />
        <Field
          name="phone"
          label="Mobile number"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          defaultValue={value('phone')}
          error={error('phone')}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-3">
          <input
            key={value('terms')}
            id={termsId}
            name="terms"
            type="checkbox"
            defaultChecked={value('terms') === 'on'}
            aria-invalid={error('terms') ? true : undefined}
            aria-describedby={error('terms') ? `${termsId}-error` : undefined}
            className="mt-0.5 size-5 shrink-0 accent-brand"
          />
          <Label htmlFor={termsId} className="text-base leading-snug font-normal">
            <span>
              I agree to the{' '}
              <a
                href="/terms"
                target="_blank"
                rel="noopener"
                className="font-medium text-brand underline underline-offset-2"
              >
                terms
                <span className="sr-only"> (opens in a new tab)</span>
              </a>{' '}
              and the{' '}
              <a
                href="/privacy"
                target="_blank"
                rel="noopener"
                className="font-medium text-brand underline underline-offset-2"
              >
                privacy policy
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              .
            </span>
          </Label>
        </div>
        {error('terms') && (
          <p id={`${termsId}-error`} className="text-sm text-status-void">
            {error('terms')}
          </p>
        )}
      </div>
      {/* Each submit renders a fresh check: tokens work once. */}
      <TurnstileWidget siteKey={siteKey} round={round} onReady={setChecked} />
      {result && (result.error || result.fieldErrors) && (
        <p role="alert" className="text-sm font-medium text-status-void">
          {result.error ?? 'Check the highlighted fields and try again.'}
        </p>
      )}
      <Button
        type="submit"
        size="touch"
        disabled={pending || !checked}
        className="sm:self-start sm:px-8"
      >
        {pending ? 'Sending your code…' : 'Email me a code'}
      </Button>
      <p className="text-sm text-ink-muted">
        {checked
          ? 'We’ll email you a 6-digit code to confirm the address.'
          : 'The button turns on once the check above has finished.'}
      </p>
    </form>
  );
}
