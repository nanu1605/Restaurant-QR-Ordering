import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CartView } from '@/features/ordering/components/cart-view';
import { tableHeading } from '@/features/ordering/format';
import { getCustomerTable } from '@/features/ordering/queries';

export async function generateMetadata({
  params,
}: Pick<PageProps<'/t/[qrToken]/cart'>, 'params'>): Promise<Metadata> {
  const table = await getCustomerTable((await params).qrToken);
  return {
    // Its own title, so screen readers announce the move from the menu.
    title: {
      absolute: table
        ? `Your order · ${table.restaurant.name} · ${tableHeading(table.tableLabel)}`
        : 'QR code not working',
    },
    robots: { index: false, follow: false },
  };
}

/** Review the cart and place the order (spec §13.1 Cart page). */
export default async function CartPage({ params }: PageProps<'/t/[qrToken]/cart'>) {
  const { qrToken } = await params;
  const table = await getCustomerTable(qrToken);
  if (!table) notFound();
  return <CartView qrToken={qrToken} table={table} />;
}
