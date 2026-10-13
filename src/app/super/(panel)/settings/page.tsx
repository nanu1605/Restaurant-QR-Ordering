import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { PlatformSettingsForm } from '@/features/platform/components/platform-settings-form';
import { formatDate } from '@/features/platform/platform';
import { getPlatformSettings } from '@/features/platform/queries';
import { discountLastDay, setupFeeDiscountPaise } from '@/features/platform/setup-fee';
import { requirePlatformPermission } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Platform settings',
};

/** Platform settings (docs/SUPER_ADMIN_PLAN.md 12a, docs/DECISIONS.md SA-4). */
export default async function SuperSettingsPage() {
  await requirePlatformPermission('settings.manage');
  const settings = await getPlatformSettings();
  const offerEnded =
    settings.setup_fee_discount_ends_at !== null &&
    settings.setup_fee_discount_paise > 0 &&
    setupFeeDiscountPaise(settings) === 0;

  return (
    <>
      <PageHeader title="Platform settings" description="Every change is in the audit log." />
      {offerEnded && settings.setup_fee_discount_ends_at && (
        <p className="text-sm text-ink">
          The launch offer’s last day was{' '}
          {formatDate(discountLastDay(settings.setup_fee_discount_ends_at))}. The website and new
          payment links show the full fee.
        </p>
      )}
      <PlatformSettingsForm settings={settings} />
    </>
  );
}
