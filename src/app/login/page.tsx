import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { Wordmark } from '@/components/shared/logo';
import { LegalLinks } from '@/features/ordering/components/legal-links';
import { allowedPanelsFor, homePathFor, safeNextPath } from '@/lib/auth/redirects';
import { getAccessSummary, getCurrentUser } from '@/lib/auth/session';

import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Log in',
};

const NOTICES: Record<string, string> = {
  no_access:
    'This account has no active restaurant. Log in with a different account or ask your manager.',
};

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : undefined;
  const error = typeof params.error === 'string' ? params.error : undefined;

  // Already signed in with access somewhere: go straight to the panel.
  if (await getCurrentUser()) {
    const access = await getAccessSummary();
    const home = homePathFor(access);
    if (home) redirect(safeNextPath(next, allowedPanelsFor(access)) ?? home);
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-6 flex flex-col gap-1">
          <Wordmark className="mb-3 h-7 self-start" />
          <h1 className="text-xl font-bold text-ink">Log in</h1>
          <p className="text-sm text-ink-muted">
            Staff: use your restaurant code and username. Owners can also use their email.
          </p>
        </div>
        <LoginForm next={next} notice={error ? NOTICES[error] : undefined} />
      </div>
      <LegalLinks />
    </main>
  );
}
