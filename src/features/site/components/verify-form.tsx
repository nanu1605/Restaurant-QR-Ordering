'use client';

import Link from 'next/link';
import { startTransition, useActionState, useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';

import { completeSignup, resendSignupCode } from '../signup-actions';
import { Field } from './contact-form';

/** Step 2 of the self-serve signup (docs/DECISIONS.md W-9): the emailed code and a password. */
export function VerifyForm() {
  const [result, action, pending] = useActionState(completeSignup, null);
  const [resent, resend, resending] = useActionState(resendSignupCode, null);
  const form = useRef<HTMLFormElement>(null);

  // After a refusal, focus the first field to fix (its message is linked to it).
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [result]);

  return (
    <div className="flex flex-col gap-4">
      {/* Submitted by hand, so a wrong code doesn't clear the password (form actions reset the form). */}
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          startTransition(() => action(formData));
        }}
        noValidate
        aria-label="Create your restaurant"
        className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-4 sm:p-8"
      >
        <Field
          name="code"
          label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          error={result?.fieldErrors?.code}
        />
        <Field
          name="password"
          label="Choose a password"
          type="password"
          autoComplete="new-password"
          error={result?.fieldErrors?.password}
          {...(result?.fieldErrors?.password ? {} : { 'aria-describedby': 'password-hint' })}
        />
        <p id="password-hint" className="-mt-3 text-sm text-ink-muted">
          At least 8 characters. You’ll log in with your email and this password.
        </p>
        {result?.error && (
          <p role="alert" className="text-sm font-medium text-status-void">
            {result.error}{' '}
            {result.restart && (
              <Link
                href={result.restart === 'login' ? '/login' : '/signup'}
                className="font-semibold text-brand underline underline-offset-2"
              >
                {result.restart === 'login' ? 'Go to log in' : 'Start again'}
              </Link>
            )}
          </p>
        )}
        <Button type="submit" size="touch" disabled={pending} className="sm:self-start sm:px-8">
          {pending ? 'Creating your restaurant…' : 'Create my restaurant'}
        </Button>
      </form>
      <form action={resend} className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Button type="submit" variant="link" className="h-11 px-0 text-sm" disabled={resending}>
          {resending ? 'Sending…' : 'Send a new code'}
        </Button>
        <Link
          href="/signup"
          className="inline-flex h-11 items-center font-medium text-brand underline-offset-2 hover:underline"
        >
          Use a different email
        </Link>
        {resent && (
          <p
            role={resent.ok ? 'status' : 'alert'}
            className={resent.ok ? 'w-full text-ink' : 'w-full text-status-void'}
          >
            {resent.message}
          </p>
        )}
      </form>
    </div>
  );
}
