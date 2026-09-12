import { CreditCard } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireMember } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Subscription',
};

export default async function SubscriptionPage() {
  // Owner only (spec §13.3).
  await requireMember(['owner']);

  return (
    <>
      <PageHeader title="Subscription" />
      <EmptyState
        icon={CreditCard}
        title="Plans and payments"
        description="Choosing a plan and paying online will be available here soon. Contact support to change your plan meanwhile."
        className="flex-1"
      />
    </>
  );
}
