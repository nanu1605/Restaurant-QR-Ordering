import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CartView } from '@/features/ordering/components/cart-view';
import { getCustomerTable } from '@/features/ordering/queries';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Review the cart and place the order (spec §13.1 Cart page). */
export default async function CartPage({ params }: PageProps<'/t/[qrToken]/cart'>) {
  const { qrToken } = await params;
  const table = await getCustomerTable(qrToken);
  if (!table) notFound();
  return <CartView qrToken={qrToken} table={table} />;
}
