import { notFound } from 'next/navigation';

import { MenuView } from '@/features/ordering/components/menu-view';
import { getCustomerTable } from '@/features/ordering/queries';

/** The menu a customer sees after scanning the table QR (spec §13.1). */
export default async function MenuPage({ params }: PageProps<'/t/[qrToken]'>) {
  const { qrToken } = await params;
  const table = await getCustomerTable(qrToken);
  if (!table) notFound();
  return <MenuView qrToken={qrToken} table={table} />;
}
