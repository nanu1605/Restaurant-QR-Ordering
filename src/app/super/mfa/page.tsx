import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { MfaEnrolment, MfaVerifyForm } from '@/features/platform/components/mfa-forms';
import { requirePlatformAdminLogin } from '@/lib/auth/guards';
import { getPlatformAdminStatus } from '@/lib/auth/session';
import { APP_NAME } from '@/lib/config';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Two-step sign-in',
};

export default async function SuperMfaPage() {
  const user = await requirePlatformAdminLogin();
  if ((await getPlatformAdminStatus()) === 'ok') redirect('/super');

  const supabase = await createClient();
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw new Error(`Could not list MFA factors: ${error.message}`);
  const enrolled = data.totp.some((factor) => factor.status === 'verified');

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-6 flex flex-col gap-1">
          <p className="text-sm font-semibold text-brand">{APP_NAME} platform admin</p>
          <h1 className="text-xl font-bold text-ink">Two-step sign-in</h1>
          <p className="text-sm text-ink-muted">
            {enrolled
              ? 'Enter the 6-digit code from your authenticator app.'
              : 'Platform admin accounts need an authenticator app, such as Google Authenticator, Microsoft Authenticator or 1Password. Set it up once; after that, each login asks for its code.'}
          </p>
        </div>
        {enrolled ? <MfaVerifyForm /> : <MfaEnrolment />}
        <form
          action="/logout"
          method="post"
          className="mt-4 flex items-center justify-between gap-2"
        >
          <p className="min-w-0 truncate text-xs text-ink-muted">{user.email}</p>
          <Button type="submit" variant="ghost" size="sm">
            Log out
          </Button>
        </form>
      </div>
    </main>
  );
}
