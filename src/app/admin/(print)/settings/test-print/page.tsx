import type { Metadata } from 'next';

import { PrintableBillPage } from '@/features/billing/components/printable-bill';
import { getSampleBill } from '@/features/billing/queries';

export const metadata: Metadata = {
  title: 'Test print',
};

/**
 * Test print (spec §15): a sample bill with the saved settings, to check the
 * printer and paper width. Nothing is saved or counted.
 */
export default async function TestPrintPage({
  searchParams,
}: PageProps<'/admin/settings/test-print'>) {
  const sample = await getSampleBill();
  const { copy } = await searchParams;

  return (
    <PrintableBillPage
      {...sample}
      copy={copy === 'office' ? 'office' : 'customer'}
      backHref="/admin/settings"
      backLabel="Back to settings"
      selfHref="/admin/settings/test-print"
    />
  );
}
