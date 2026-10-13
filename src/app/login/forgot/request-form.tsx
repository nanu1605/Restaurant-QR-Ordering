'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { TurnstileWidget } from '@/features/site/components/turnstile-widget';

import { Field } from '../field';
import { requestPasswordReset, type ResetRequestState } from './actions';

const TURNSTILE_WORDS = {
  checkFailed: 'The check that you’re not a robot didn’t load. Try again.',
  retry: 'Try again',
};

type State = { result: ResetRequestState; round: number };

/** Step 1 of "Forgot password": the email and the bot check. */
export function RequestForm({ siteKey }: { siteKey: string }) {
  // Each answer needs a fresh bot check: its token works only once.
  const [{ result, round }, action, pending] = useActionState(
    async (previous: State, formData: FormData): Promise<State> => ({
      result: await requestPasswordReset(previous.result, formData),
      round: previous.round + 1,
    }),
    { result: null, round: 0 },
  );
  const [checked, setChecked] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  // On arrival (also back from the code step), focus the email field; after a refusal, the
  // field to fix (its message is linked to it).
  useEffect(() => {
    form.current
      ?.querySelector<HTMLElement>(result ? '[aria-invalid="true"]' : 'input[name="email"]')
      ?.focus();
  }, [result]);

  return (
    <form ref={form} action={action} noValidate className="flex flex-col gap-4">
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        defaultValue={result?.email}
        error={result?.fieldErrors?.email}
        autoCapitalize="none"
        spellCheck={false}
      />
      <TurnstileWidget
        t={TURNSTILE_WORDS}
        lang="en"
        siteKey={siteKey}
        round={round}
        onReady={setChecked}
      />
      {result?.error && (
        <p role="alert" className="text-sm font-medium text-status-void">
          {result.error}
        </p>
      )}
      <Button type="submit" size="touch" disabled={pending || !checked}>
        {pending ? 'Sending…' : 'Email me a code'}
      </Button>
    </form>
  );
}
