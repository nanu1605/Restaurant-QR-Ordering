import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { hasFeature, upgradeHint } from '@/features/plans/plan-features';
import { getPlanFeatures } from '@/features/plans/queries';
import { SettingsTabs } from '@/features/settings/components/settings-tabs';
import { getRestaurantSettings } from '@/features/settings/queries';
import { getRestaurantAccess } from '@/lib/auth/access';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { getPublicEnv } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Settings',
};

export default async function SettingsPage() {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const [settings, plan, access] = await Promise.all([
    getRestaurantSettings(membership.restaurant.id),
    getPlanFeatures(membership.restaurant.id),
    getRestaurantAccess(membership.restaurant.id),
  ]);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Restaurant details, tax, bills and ordering rules."
      />
      <SettingsTabs
        settings={settings}
        supabaseUrl={getPublicEnv().NEXT_PUBLIC_SUPABASE_URL}
        canShowUpiQr={hasFeature(plan, 'upi_qr_on_bill')}
        upgradeHint={upgradeHint('upi_qr_on_bill')}
        readOnly={access.state !== 'full'}
      />
    </>
  );
}
