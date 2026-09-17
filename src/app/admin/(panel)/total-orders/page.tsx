import type { Metadata } from 'next';

import { PageHeader } from '@/components/shared/page-header';
import { TotalOrdersFiltersForm } from '@/features/billing/components/total-orders-filters';
import {
  TotalOrdersResults,
  TotalOrdersSummary,
} from '@/features/billing/components/total-orders-view';
import { getTotalOrders } from '@/features/billing/queries';
import { totalOrdersFilters } from '@/features/billing/schemas';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Total orders',
};

/**
 * Total orders (spec §13.3): billed tables for a business-day range with a
 * summary strip and filters, and tables closed without a bill.
 */
export default async function TotalOrdersPage({ searchParams }: PageProps<'/admin/total-orders'>) {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const filters = totalOrdersFilters(await searchParams);
  const data = await getTotalOrders(filters);

  return (
    <>
      <PageHeader
        title="Total orders"
        description="Every billed table with its invoice, waiter and payment. Days start at the business day start hour."
      />
      <TotalOrdersFiltersForm data={data} filters={filters} />
      <TotalOrdersSummary data={data} />
      <TotalOrdersResults data={data} filters={filters} timezone={membership.restaurant.timezone} />
    </>
  );
}
