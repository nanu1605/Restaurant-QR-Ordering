import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/shared/page-header';
import { GetHelpForm } from '@/features/support/components/get-help-form';
import { OwnerRequests } from '@/features/support/components/owner-requests';
import { listOwnerSupportRequests } from '@/features/support/queries';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { getCurrentUser } from '@/lib/auth/session';
import { isStaffEmail } from '@/lib/auth/staff-email';
import { firstParam } from '@/lib/date-range';
import { getServerEnv } from '@/lib/env.server';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'Get help',
};

/**
 * Get help (docs/SUPER_ADMIN_PLAN.md 13b, docs/DECISIONS.md SA-42): ask the
 * MenuMesh team, and see where each request stands.
 */
export default async function GetHelpPage({ searchParams }: PageProps<'/admin/help'>) {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  // Not as the restaurant: a support session asks from /super (docs/DECISIONS.md SA-48).
  if (membership.support) redirect('/admin');
  const from = firstParam(await searchParams, 'from');
  const supabase = await createClient();
  const [requests, restaurant, user] = await Promise.all([
    listOwnerSupportRequests(),
    supabase.from('restaurants').select('phone').eq('id', membership.restaurant.id).single(),
    getCurrentUser(),
  ]);
  // An owner the team set up without an email has a made-up login address
  // (lib/auth/staff-email.ts), as every other login does.
  const email =
    user?.email && !isStaffEmail(user.email, getServerEnv().STAFF_EMAIL_DOMAIN) ? user.email : null;

  return (
    <>
      <PageHeader
        title="Get help"
        description="Ask the MenuMesh team about anything in MenuMesh. We get back to you the way you choose."
      />
      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <section
          aria-labelledby="new-request-title"
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        >
          <h2 id="new-request-title" className="text-base font-semibold text-ink">
            New request
          </h2>
          <GetHelpForm
            from={from?.startsWith('/admin') ? from.slice(0, 200) : null}
            phone={restaurant.data?.phone ?? null}
            email={email}
          />
        </section>
        <section aria-labelledby="requests-title" className="flex flex-col gap-3">
          <h2 id="requests-title" className="text-base font-semibold text-ink">
            Your requests
          </h2>
          <OwnerRequests requests={requests} timezone={membership.restaurant.timezone} />
        </section>
      </div>
    </>
  );
}
