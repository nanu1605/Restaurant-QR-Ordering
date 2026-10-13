'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import { Field } from '../field';
import { resetPassword, restartPasswordReset } from './actions';

/** Step 2 of "Forgot password": the emailed code and the new password, typed twice. */
export function ResetForm() {
  const [result, action, pending] = useActionState(resetPassword, null);
  // Controlled, so the form's reset after each answer doesn't clear them.
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const form = useRef<HTMLFormElement>(null);

  // After a refusal, focus the first field to fix (its message is linked to it).
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [result]);

  return (
    <div className="flex flex-col gap-2">
      <form
        ref={form}
        action={action}
        noValidate
        aria-label="New password"
        className="flex flex-col gap-4"
      >
        <Field
          name="code"
          label="Code from the email"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          error={result?.fieldErrors?.code}
        />
        <Field
          name="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={result?.fieldErrors?.password}
          {...(result?.fieldErrors?.password ? {} : { 'aria-describedby': 'password-hint' })}
        />
        <p id="password-hint" className="-mt-3 text-sm text-ink-muted">
          At least 8 characters.
        </p>
        <Field
          name="confirm"
          label="New password again"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          error={result?.fieldErrors?.confirm}
        />
        {result?.error && (
          <p role="alert" className="text-sm font-medium text-status-void">
            {result.error}
          </p>
        )}
        <Button type="submit" size="touch" disabled={pending}>
          {pending ? 'Saving…' : 'Set new password'}
        </Button>
      </form>
      <form action={restartPasswordReset}>
        <Button
          type="submit"
          variant="link"
          className="h-11 px-0 text-sm text-ink underline underline-offset-4"
        >
          Get a new code, or use another email
        </Button>
      </form>
    </div>
  );
}
