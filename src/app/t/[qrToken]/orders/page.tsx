import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { OrdersView } from '@/features/ordering/components/orders-view';
import { readDeviceId } from '@/features/ordering/device';
import { getCustomerSession } from '@/features/ordering/queries';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** The table's orders and their statuses (spec §13.1 Orders page). */
export default async function OrdersPage({ params }: PageProps<'/t/[qrToken]/orders'>) {
  const { qrToken } = await params;
  const session = await getCustomerSession(qrToken, await readDeviceId());
  if (!session) notFound();
  return <OrdersView qrToken={qrToken} initial={session} />;
}
