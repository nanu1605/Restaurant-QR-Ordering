import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import { BillBuilder } from '@/features/billing/components/bill-builder';
import { getSessionBillingState } from '@/features/billing/queries';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Generate bill',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bill builder for one open table (spec §13.3 Billing). A billed table opens its bill. */
export default async function BillBuilderPage({ params }: PageProps<'/admin/billing/[sessionId]'>) {
  await requireMember(ADMIN_PANEL_ROLES);
  const { sessionId } = await params;
  if (!UUID.test(sessionId)) notFound();

  const billing = await getSessionBillingState(sessionId);
  if (billing.state === 'billed') redirect(`/admin/bills/${billing.billId}`);
  if (billing.state === 'closed') notFound();

  return (
    <>
      <PageHeader
        title="Generate bill"
        description="Check the dishes, add a discount if needed, then generate the bill."
        actions={
          <Link
            href="/admin/billing"
            className={buttonVariants({ variant: 'outline', size: 'lg' })}
          >
            <ArrowLeft aria-hidden /> Billing
          </Link>
        }
      />
      <BillBuilder sessionId={sessionId} />
    </>
  );
}
