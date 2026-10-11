'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import type { SiteContent, SiteLang } from '../content';
import { completeSignup, resendSignupCode } from '../signup-actions';
import { Field } from './contact-form';

const LINK_CLASS = 'font-semibold text-brand underline underline-offset-2';

type Words = SiteContent['verify']['form'];

/**
 * Step 2 of the self-serve signup (docs/DECISIONS.md W-9): the emailed code
 * and a password. `restartHref` is /signup with the plan chosen on /pricing.
 */
export function VerifyForm({
  t,
  lang,
  restartHref,
}: {
  t: Words;
  lang: SiteLang;
  restartHref: string;
}) {
  const [resent, resend, resending] = useActionState(resendSignupCode, null);
  // Kept here, so neither a wrong code nor a new code makes the visitor type it again.
  const [password, setPassword] = useState('');

  return (
    <div className="flex flex-col gap-4">
      {/* A new code starts the form afresh: old errors no longer apply. */}
      <CodeForm
        key={resent?.sends ?? 0}
        t={t}
        lang={lang}
        password={password}
        onPassword={setPassword}
        restartHref={restartHref}
      />
      <form action={resend} className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <input type="hidden" name="lang" value={lang} />
        <Button type="submit" variant="link" className="h-11 px-0 text-sm" disabled={resending}>
          {resending ? t.sending : t.resend}
        </Button>
        <Link
          href={restartHref}
          className="inline-flex h-11 items-center font-medium text-brand underline-offset-2 hover:underline"
        >
          {t.otherEmail}
        </Link>
        <p
          aria-live="polite"
          className={resent?.ok ? 'w-full text-ink' : 'w-full text-status-void'}
        >
          {resent?.message}
          {resent?.restart && (
            <>
              {' '}
              <Link href={restartHref} className={LINK_CLASS}>
                {t.restart}
              </Link>
            </>
          )}
        </p>
      </form>
    </div>
  );
}

function CodeForm({
  t,
  lang,
  password,
  onPassword,
  restartHref,
}: {
  t: Words;
  lang: SiteLang;
  password: string;
  onPassword: (password: string) => void;
  restartHref: string;
}) {
  const [result, action, pending] = useActionState(completeSignup, null);
  // Controlled, so the form's reset after each answer doesn't clear them.
  const [code, setCode] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const message = useRef<HTMLParagraphElement>(null);

  // After a refusal, focus the first field to fix (its message is linked to it).
  useEffect(() => {
    if (result?.restart) message.current?.focus();
    else form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [result]);

  if (result?.restart) {
    // The signup can't go on: only the way forward is left.
    return (
      <p
        ref={message}
        tabIndex={-1}
        role="alert"
        className="rounded-2xl border border-line bg-surface p-4 text-base font-medium text-ink outline-none sm:p-8"
      >
        {result.error}{' '}
        <Link href={result.restart === 'login' ? '/login' : restartHref} className={LINK_CLASS}>
          {result.restart === 'login' ? t.login : t.restart}
        </Link>
      </p>
    );
  }

  return (
    <form
      ref={form}
      action={action}
      noValidate
      aria-label={t.label}
      className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-4 sm:p-8"
    >
      <input type="hidden" name="lang" value={lang} />
      <Field
        name="code"
        label={t.code}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        error={result?.fieldErrors?.code}
      />
      <Field
        name="password"
        label={t.password}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => onPassword(event.target.value)}
        error={result?.fieldErrors?.password}
        {...(result?.fieldErrors?.password ? {} : { 'aria-describedby': 'password-hint' })}
      />
      <p id="password-hint" className="-mt-3 text-sm text-ink-muted">
        {t.passwordHint}
      </p>
      {result?.error && (
        <p role="alert" className="text-sm font-medium text-status-void">
          {result.error}
        </p>
      )}
      <Button type="submit" size="touch" disabled={pending} className="sm:self-start sm:px-8">
        {pending ? t.creating : t.submit}
      </Button>
    </form>
  );
}
