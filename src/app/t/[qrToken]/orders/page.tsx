import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { OrdersView } from '@/features/ordering/components/orders-view';
import { readDeviceId } from '@/features/ordering/device';
import { tableHeading } from '@/features/ordering/format';
import { getCustomerSession, getCustomerTable } from '@/features/ordering/queries';

export async function generateMetadata({
  params,
}: Pick<PageProps<'/t/[qrToken]/orders'>, 'params'>): Promise<Metadata> {
  const table = await getCustomerTable((await params).qrToken);
  return {
    // Its own title, so screen readers announce the move from the menu.
    title: {
      absolute: table
        ? `Your table’s orders · ${table.restaurant.name} · ${tableHeading(table.tableLabel)}`
        : 'QR code not working',
    },
    robots: { index: false, follow: false },
  };
}

/** The table's orders and their statuses (spec §13.1 Orders page). */
export default async function OrdersPage({ params }: PageProps<'/t/[qrToken]/orders'>) {
  const { qrToken } = await params;
  const session = await getCustomerSession(qrToken, await readDeviceId());
  if (!session) notFound();
  return <OrdersView qrToken={qrToken} initial={session} />;
}
