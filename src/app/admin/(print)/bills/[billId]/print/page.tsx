import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { PrintableBillPage } from '@/features/billing/components/printable-bill';
import { getBill } from '@/features/billing/queries';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Print bill',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bill print page (spec §15): opens the print dialog on load. */
export default async function PrintBillPage({
  params,
  searchParams,
}: PageProps<'/admin/bills/[billId]/print'>) {
  // Printing a bill copy is the restaurant's own (docs/DECISIONS.md SA-49).
  if ((await requireMember(ADMIN_PANEL_ROLES)).support) redirect('/admin');
  const { billId } = await params;
  if (!UUID.test(billId)) notFound();
  const detail = await getBill(billId);
  if (!detail) notFound();
  const { copy } = await searchParams;

  return (
    <PrintableBillPage
      bill={detail.bill}
      print={detail.print}
      copy={copy === 'office' ? 'office' : 'customer'}
      backHref={`/admin/bills/${billId}`}
      backLabel="Back to bill"
      selfHref={`/admin/bills/${billId}/print`}
    />
  );
}
