import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PrintableBillPage } from '@/features/billing/components/printable-bill';
import { getBill } from '@/features/billing/queries';

export const metadata: Metadata = {
  title: 'Print bill',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bill print page (spec §15): opens the print dialog on load. */
export default async function PrintBillPage({
  params,
  searchParams,
}: PageProps<'/admin/bills/[billId]/print'>) {
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
