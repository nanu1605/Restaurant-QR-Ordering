import { LifeBuoy } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import { hasFeature, upgradeHint } from '@/features/plans/plan-features';
import { getPlanFeatures } from '@/features/plans/queries';
import { SettingsTabs } from '@/features/settings/components/settings-tabs';
import { getRestaurantSettings } from '@/features/settings/queries';
import { getSupportAccess } from '@/features/support/access-queries';
import { SupportAccessCard } from '@/features/support/components/support-access-card';
import { getRestaurantAccess } from '@/lib/auth/access';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { getPublicEnv } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Settings',
};

export default async function SettingsPage() {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const owner = membership.role === 'owner';
  const [settings, plan, access, supportAccess] = await Promise.all([
    getRestaurantSettings(membership.restaurant.id),
    getPlanFeatures(membership.restaurant.id),
    getRestaurantAccess(membership.restaurant.id),
    // MenuMesh support access is the owner's to give (docs/DECISIONS.md SA-47).
    owner ? getSupportAccess(membership.restaurant.id, membership.restaurant.timezone) : null,
  ]);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Restaurant details, tax, bills and ordering rules."
        actions={
          // A support session asks for help from /super, not as the restaurant.
          !membership.support && (
            <Link
              href="/admin/help?from=/admin/settings"
              className={buttonVariants({ variant: 'outline', size: 'touch' })}
            >
              <LifeBuoy aria-hidden /> Get help
            </Link>
          )
        }
      />
      <SettingsTabs
        settings={settings}
        supabaseUrl={getPublicEnv().NEXT_PUBLIC_SUPABASE_URL}
        canShowUpiQr={hasFeature(plan, 'upi_qr_on_bill')}
        upgradeHint={upgradeHint('upi_qr_on_bill')}
        readOnly={access.state !== 'full'}
      />
      {supportAccess && (
        <SupportAccessCard
          open={supportAccess.open}
          history={supportAccess.history}
          truncated={supportAccess.truncated}
          timezone={membership.restaurant.timezone}
        />
      )}
    </>
  );
}
