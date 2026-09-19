'use client';

import Image from 'next/image';
import { useActionState, useId, useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { startTotpEnrolment, verifyTotp, type TotpEnrolment } from '../mfa-actions';

/** First visit: add the account to an authenticator app, then confirm a code. */
export function MfaEnrolment() {
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!enrolment) {
    return (
      <div className="flex flex-col gap-3">
        {error && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        )}
        <Button
          size="touch"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await startTotpEnrolment();
              if (result.ok) setEnrolment(result.data);
              else setError(result.error);
            })
          }
        >
          {pending ? 'Preparing…' : 'Set up authenticator app'}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-ink">
        <li>In your authenticator app, add an account and scan this code.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <Image
        src={enrolment.qrCode}
        alt="QR code to add this account to your authenticator app"
        width={176}
        height={176}
        unoptimized
        className="self-center rounded-md border border-line bg-white p-2"
      />
      <div className="flex flex-col gap-1">
        <p className="text-xs text-ink-muted">Can&apos;t scan? Type this key instead:</p>
        <code
          data-testid="totp-secret"
          className="rounded-md border border-line bg-muted px-2 py-1 font-mono text-sm break-all text-ink"
        >
          {enrolment.secret}
        </code>
      </div>
      <MfaVerifyForm factorId={enrolment.factorId} />
    </div>
  );
}

/** Enter the current code. With a factorId, this also finishes the enrolment. */
export function MfaVerifyForm({ factorId }: { factorId?: string }) {
  const [state, action, pending] = useActionState(verifyTotp, null);
  const id = useId();

  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      {factorId && <input type="hidden" name="factorId" value={factorId} />}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-code`}>6-digit code</Label>
        <Input
          id={`${id}-code`}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          autoFocus
          aria-invalid={state?.error ? true : undefined}
          aria-describedby={state?.error ? `${id}-error` : undefined}
        />
        {state?.error && (
          <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive">
            {state.error}
          </p>
        )}
      </div>
      <Button type="submit" size="touch" disabled={pending}>
        {pending ? 'Checking…' : 'Verify'}
      </Button>
    </form>
  );
}
