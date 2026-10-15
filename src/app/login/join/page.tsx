import type { Metadata } from 'next';
import Link from 'next/link';

import { Wordmark } from '@/components/shared/logo';
import { INVITE_GONE, TEAM_ROLE_LABELS, type TeamRole } from '@/features/platform/team';
import { firstParam } from '@/lib/date-range';
import { hashCode } from '@/lib/one-time-code';
import { createAdminClient } from '@/lib/supabase/admin';

import { JoinForm } from './join-form';

export const metadata: Metadata = {
  title: 'Join the MenuMesh team',
  robots: { index: false },
  // The invite is in the address: never send it on to another site.
  referrer: 'no-referrer',
};

/**
 * Where an invite link lands (docs/SUPER_ADMIN_PLAN.md 13g, docs/DECISIONS.md
 * SA-70+): the new team member chooses a password, then sets up the second
 * factor on /super/mfa.
 */
export default async function JoinPage({ searchParams }: PageProps<'/login/join'>) {
  const token = firstParam(await searchParams, 'token');
  const invite = token && token.length <= 100 ? await lookUp(token) : null;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-6 flex flex-col gap-1">
          <Wordmark className="mb-3 h-7 self-start" />
          <h1 className="text-xl font-bold text-ink">Join the MenuMesh team</h1>
          {invite && (
            <p className="text-sm text-ink-muted">
              Hi {invite.display_name}: you’re joining as {TEAM_ROLE_LABELS[invite.role]}. Choose a
              password for {invite.email}. Next, you’ll set up an authenticator app.
            </p>
          )}
        </div>
        {invite && token ? (
          <JoinForm token={token} />
        ) : (
          <p className="text-sm text-ink">{INVITE_GONE}</p>
        )}
        <Link
          href="/login"
          className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-ink underline underline-offset-4"
        >
          Go to log in
        </Link>
      </div>
    </main>
  );
}

async function lookUp(token: string) {
  const { data, error } = await createAdminClient().rpc('platform_invite_lookup', {
    p_token_hash: hashCode('team-invite', token),
  });
  if (error) throw new Error(`Could not read the invite: ${error.message}`);
  const invite = data as {
    email: string;
    display_name: string;
    role: TeamRole;
    expired: boolean;
  } | null;
  return invite && !invite.expired ? invite : null;
}
