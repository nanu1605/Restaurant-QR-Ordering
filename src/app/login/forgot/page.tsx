import type { Metadata } from 'next';
import Link from 'next/link';

import { Wordmark } from '@/components/shared/logo';
import { LegalLinks } from '@/features/ordering/components/legal-links';
import { INSTALLABLE } from '@/lib/config';
import { emailConfig } from '@/lib/email/resend';
import { turnstileConfig } from '@/lib/turnstile';

import { resetFromCookie } from './reset';
import { RequestForm } from './request-form';
import { ResetForm } from './reset-form';

export const metadata: Metadata = {
  ...INSTALLABLE,
  title: 'Reset your password',
  description: 'Reset the password of a MenuMesh owner or platform admin account by email.',
  robots: { index: false },
};

/**
 * "Forgot password" (docs/DECISIONS.md P11-6): an email and the bot check,
 * then the emailed code and a new password. Staff ask their owner or manager.
 */
export default async function ForgotPasswordPage() {
  // It needs the bot check and email; without them owners ask support, as staff ask their owner.
  const turnstile = emailConfig() ? turnstileConfig() : null;
  const reset = turnstile ? await resetFromCookie() : null;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-6 flex flex-col gap-1">
          <Wordmark className="mb-3 h-7 self-start" />
          <h1 className="text-xl font-bold text-ink">Reset your password</h1>
          <p className="text-sm text-ink-muted">
            {reset
              ? `If ${reset.email} has a MenuMesh account, we’ve emailed it a 6-digit code. It works for 15 minutes.`
              : 'Enter the email you log in with, and we’ll email you a code. Staff without an email: ask your owner or manager to reset your password.'}
          </p>
        </div>
        {!turnstile ? (
          <p className="text-sm text-ink">
            Password reset by email isn’t available right now. Contact MenuMesh support to reset it.
          </p>
        ) : reset ? (
          <ResetForm />
        ) : (
          <RequestForm siteKey={turnstile.siteKey} />
        )}
        <Link
          href="/login"
          className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-ink underline underline-offset-4"
        >
          Back to log in
        </Link>
      </div>
      <LegalLinks />
    </main>
  );
}
