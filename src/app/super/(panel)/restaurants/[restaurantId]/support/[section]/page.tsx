import { ArrowLeft, Eye } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/shared/page-header';
import { buttonVariants } from '@/components/ui/button';
import { parseTotalOrders } from '@/features/billing/bill';
import { TotalOrdersFiltersForm } from '@/features/billing/components/total-orders-filters';
import {
  TotalOrdersResults,
  TotalOrdersSummary,
} from '@/features/billing/components/total-orders-view';
import { readTotalOrdersParams } from '@/features/billing/schemas';
import { SupportBoard } from '@/features/platform/components/support-board';
import { SupportMenuList, SupportTablesList } from '@/features/platform/components/support-view';
import {
  parseSupportMenu,
  parseSupportTables,
  SUPPORT_SECTION_LABELS,
  SUPPORT_SECTIONS,
  type SupportSection,
} from '@/features/platform/platform';
import { getSupportView } from '@/features/platform/queries';
import { requirePlatformAdmin } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Support view',
};

function isSection(value: string): value is SupportSection {
  return (SUPPORT_SECTIONS as readonly string[]).includes(value);
}

/**
 * Read-only support view (spec §13.4, docs/DECISIONS.md P7-6): a restaurant's
 * menu, tables, live board or Total orders as its manager sees them, with no
 * way to change anything. The database logs each look.
 */
export default async function SupportViewPage({
  params,
  searchParams,
}: PageProps<'/super/restaurants/[restaurantId]/support/[section]'>) {
  await requirePlatformAdmin();
  const { restaurantId, section } = await params;
  if (!isSection(section)) notFound();

  const totalOrders = section === 'total_orders' ? readTotalOrdersParams(await searchParams) : null;
  const view = await getSupportView(restaurantId, section, totalOrders?.filters);
  if (!view) notFound();
  const { restaurant } = view;
  const basePath = `/super/restaurants/${restaurant.id}/support`;

  return (
    <>
      <Link
        href={`/super/restaurants/${restaurant.id}`}
        className="inline-flex items-center gap-1 self-start text-sm font-medium text-brand underline-offset-4 hover:underline"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {restaurant.name}
      </Link>
      <PageHeader
        title={`${SUPPORT_SECTION_LABELS[section]}: ${restaurant.name}`}
        description={
          <span className="inline-flex items-center gap-1">
            <Eye aria-hidden className="size-4" />
            Read-only support view. Each look is recorded in the restaurant&apos;s audit log.
          </span>
        }
      />
      <nav aria-label="Support sections" className="flex flex-wrap gap-2">
        {SUPPORT_SECTIONS.map((candidate) => (
          <Link
            key={candidate}
            href={`${basePath}/${candidate}`}
            aria-current={candidate === section ? 'page' : undefined}
            className={buttonVariants({
              variant: candidate === section ? 'default' : 'outline',
              size: 'touch',
            })}
          >
            {SUPPORT_SECTION_LABELS[candidate]}
          </Link>
        ))}
      </nav>

      {section === 'menu' && <SupportMenuList menu={parseSupportMenu(view.data)} />}
      {section === 'tables' && <SupportTablesList tables={parseSupportTables(view.data)} />}
      {section === 'board' && <SupportBoard json={view.data} />}
      {section === 'total_orders' && totalOrders && (
        <TotalOrdersSection
          json={view.data}
          filters={totalOrders.filters}
          notice={totalOrders.notice}
          timezone={restaurant.timezone}
          basePath={`${basePath}/total_orders`}
        />
      )}
    </>
  );
}

function TotalOrdersSection({
  json,
  filters,
  notice,
  timezone,
  basePath,
}: {
  json: unknown;
  filters: ReturnType<typeof readTotalOrdersParams>['filters'];
  notice: string | null;
  timezone: string;
  basePath: string;
}) {
  const data = parseTotalOrders(json);
  return (
    <>
      <TotalOrdersFiltersForm data={data} filters={filters} />
      {notice && (
        <p role="status" className="rounded-lg border-2 border-attention bg-surface p-3 text-ink">
          {notice}
        </p>
      )}
      <TotalOrdersSummary data={data} />
      <TotalOrdersResults
        data={data}
        filters={filters}
        timezone={timezone}
        basePath={basePath}
        linkBills={false}
      />
    </>
  );
}
