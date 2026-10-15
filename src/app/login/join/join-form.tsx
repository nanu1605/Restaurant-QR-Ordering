'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import { Field } from '../field';
import { joinTeam } from './actions';

/** The new member's password, typed twice; the invite rides along unseen. */
export function JoinForm({ token }: { token: string }) {
  const [result, action, pending] = useActionState(joinTeam, null);
  // Controlled, so the form's reset after each answer doesn't clear them.
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (result) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [result]);

  return (
    <form
      ref={form}
      action={action}
      noValidate
      aria-label="Choose your password"
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="token" value={token} />
      <Field
        name="password"
        label="Password"
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
        label="Password again"
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
        {pending ? 'Joining…' : 'Join the team'}
      </Button>
    </form>
  );
}
