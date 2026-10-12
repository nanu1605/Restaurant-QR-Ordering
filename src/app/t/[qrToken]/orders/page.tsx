import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CustomerBill } from '@/features/ordering/components/customer-bill';
import { OrdersView } from '@/features/ordering/components/orders-view';
import { readDeviceId } from '@/features/ordering/device';
import { getStrings } from '@/features/ordering/lang';
import { getCustomerSession, getCustomerTable } from '@/features/ordering/queries';

export async function generateMetadata({
  params,
}: Pick<PageProps<'/t/[qrToken]/orders'>, 'params'>): Promise<Metadata> {
  const table = await getCustomerTable((await params).qrToken);
  const t = await getStrings();
  return {
    // Its own title, so screen readers announce the move from the menu.
    title: {
      absolute: table
        ? `${t.orders.title} · ${table.restaurant.name} · ${t.table(table.tableLabel)}`
        : t.qrNotWorking,
    },
    robots: { index: false, follow: false },
  };
}

/** The table's orders and their statuses (spec §13.1 Orders page). */
export default async function OrdersPage({ params }: PageProps<'/t/[qrToken]/orders'>) {
  const { qrToken } = await params;
  const session = await getCustomerSession(qrToken, await readDeviceId());
  if (!session) notFound();
  return (
    <OrdersView
      qrToken={qrToken}
      initial={session.view}
      bill={session.bill && <CustomerBill {...session.bill} />}
    />
  );
}
