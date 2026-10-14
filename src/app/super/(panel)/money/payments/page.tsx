import { Download, ReceiptIndianRupee } from 'lucide-react';
import type { Metadata } from 'next';
import Form from 'next/form';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { EmptyState } from '@/components/shared/empty-state';
import { Money } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import { Pager } from '@/components/shared/pager';
import { ScrollRegion } from '@/components/shared/scroll-region';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CopyButton } from '@/features/platform/components/copy-button';
import { filterParams, readPaymentFilters } from '@/features/platform/params';
import {
  formatDate,
  formatPeriod,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  PAYMENT_PURPOSE_LABELS,
  PAYMENT_PURPOSES,
  paymentPlanLabel,
  paymentRecordedBy,
  todayInIndia,
  type PaymentRow,
} from '@/features/platform/platform';
import { listPayments, listPlans } from '@/features/platform/queries';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { hrefWithParams, platformPresets } from '@/lib/date-range';

export const metadata: Metadata = {
  title: 'Payments',
};

const PATH = '/super/money/payments';
/** The CSV is one call; past this, narrow the dates (platform_list_payments). */
const EXPORT_LIMIT = 10_000;

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm';

/**
 * The payments ledger (docs/SUPER_ADMIN_PLAN.md 12c, docs/DECISIONS.md
 * SA-18): what restaurants paid MenuMesh, with GST apart from the amount.
 */
export default async function PaymentsPage({ searchParams }: PageProps<'/super/money/payments'>) {
  await requirePlatformPermission('money.view');
  const today = todayInIndia();
  const filters = readPaymentFilters(await searchParams, today);
  const [list, plans] = await Promise.all([listPayments(filters), listPlans()]);
  const withoutPage = { ...filters, page: undefined };
  const current = filterParams(withoutPage);
  const presets = platformPresets(today);
  const { totals } = list;

  const periodLink = (range: { from?: string; to?: string; period?: string }) =>
    hrefWithParams(
      PATH,
      filterParams({ ...withoutPage, from: undefined, to: undefined, period: undefined, ...range }),
    );

  return (
    <>
      <PageHeader
        title="Payments"
        description="What restaurants paid MenuMesh. Amounts are before GST; GST and the total paid are beside them."
        actions={
          totals.count > EXPORT_LIMIT ? (
            <p className="text-sm text-ink-muted">
              The CSV holds up to 10,000 payments. Choose fewer days to export.
            </p>
          ) : (
            <a
              href={hrefWithParams(`${PATH}/export`, current)}
              download
              className={buttonVariants({ variant: 'outline', size: 'touch' })}
            >
              <Download aria-hidden />
              Export CSV
            </a>
          )
        }
      />

      <nav aria-label="Period" className="flex flex-wrap gap-2">
        {presets.map((preset) => {
          const active = filters.from === preset.from && filters.to === preset.to;
          return (
            <Link
              key={preset.key}
              href={periodLink({ from: preset.from, to: preset.to })}
              aria-current={active ? 'page' : undefined}
              className={buttonVariants({ variant: active ? 'default' : 'outline', size: 'sm' })}
            >
              {preset.label}
            </Link>
          );
        })}
        <Link
          href={periodLink({ period: 'all' })}
          aria-current={filters.period === 'all' ? 'page' : undefined}
          className={buttonVariants({
            variant: filters.period === 'all' ? 'default' : 'outline',
            size: 'sm',
          })}
        >
          All time
        </Link>
      </nav>

      <Form
        key={JSON.stringify(current)}
        action={PATH}
        role="search"
        aria-label="Payments"
        className="grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-6"
      >
        {filters.period === 'all' && <input type="hidden" name="period" value="all" />}
        <label className="flex flex-col gap-1 text-sm font-medium text-ink sm:col-span-2">
          Restaurant
          <Input
            type="search"
            name="q"
            defaultValue={filters.q}
            placeholder="Name or code"
            className="h-11 md:h-9"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          For
          <select name="purpose" defaultValue={filters.purpose ?? ''} className={SELECT_CLASS}>
            <option value="">Everything</option>
            {PAYMENT_PURPOSES.map((purpose) => (
              <option key={purpose} value={purpose}>
                {PAYMENT_PURPOSE_LABELS[purpose]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Method
          <select name="method" defaultValue={filters.method ?? ''} className={SELECT_CLASS}>
            <option value="">Any method</option>
            {PAYMENT_METHODS.map((method) => (
              <option key={method} value={method}>
                {PAYMENT_METHOD_LABELS[method]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Plan
          <select name="plan" defaultValue={filters.plan ?? ''} className={SELECT_CLASS}>
            <option value="">Any plan</option>
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3 sm:col-span-2 lg:col-span-1 lg:grid-cols-1">
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            From
            <Input type="date" name="from" defaultValue={filters.from} className="h-11 md:h-9" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            To
            <Input type="date" name="to" defaultValue={filters.to} className="h-11 md:h-9" />
          </label>
        </div>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-6">
          <Button type="submit" size="touch">
            Apply
          </Button>
          <Link href={PATH} className={buttonVariants({ variant: 'ghost', size: 'touch' })}>
            Clear
          </Link>
        </div>
      </Form>

      <section
        aria-labelledby="payments-totals"
        className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-4"
      >
        <h2 id="payments-totals" className="text-sm font-medium text-ink-muted">
          {filters.period === 'all'
            ? 'Every payment'
            : `${formatDate(filters.from ?? null)} to ${formatDate(filters.to ?? today)}`}
          , {totals.count} {totals.count === 1 ? 'payment' : 'payments'}
        </h2>
        <p className="text-lg font-semibold text-ink tabular-nums" data-testid="payments-collected">
          Collected <Money paise={totals.base_paise} /> + GST <Money paise={totals.gst_paise} /> ={' '}
          <Money paise={totals.amount_paise} />
        </p>
        <p className="text-sm text-ink-muted">
          Subscriptions <Money paise={totals.subscription_base_paise} />, setup fees{' '}
          <Money paise={totals.setup_fee_base_paise} /> (before GST)
        </p>
      </section>

      {list.rows.length === 0 ? (
        <EmptyState
          icon={ReceiptIndianRupee}
          title="No payments here"
          description="Try another period, or clear the filters."
        />
      ) : (
        <>
          <ul aria-label="Payments" className="flex flex-col gap-3 md:hidden">
            {list.rows.map((row) => (
              <PaymentCard key={row.payment_id} row={row} />
            ))}
          </ul>
          <ScrollRegion
            label="Payments"
            className="hidden rounded-lg border border-line bg-surface md:block"
          >
            <Table label="Payments">
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Restaurant</TableHead>
                  <TableHead>For</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">GST</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Razorpay payment ID</TableHead>
                  <TableHead>Recorded by</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.rows.map((row) => (
                  <TableRow key={row.payment_id}>
                    <TableCell>{formatDate(row.created_at)}</TableCell>
                    <TableCell>
                      <RestaurantLink row={row} />
                    </TableCell>
                    <TableCell>{paymentPlanLabel(row)}</TableCell>
                    <TableCell className="text-right">
                      <Money paise={row.base_paise} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money paise={row.gst_paise} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money paise={row.amount_paise} />
                    </TableCell>
                    <TableCell>{PAYMENT_METHOD_LABELS[row.method]}</TableCell>
                    <TableCell>{formatPeriod(row.period_start, row.period_end)}</TableCell>
                    <TableCell>
                      <RazorpayId id={row.razorpay_payment_id} />
                    </TableCell>
                    <TableCell>{paymentRecordedBy(row)}</TableCell>
                    <TableCell className="max-w-64 whitespace-normal">{row.notes ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={3} className="font-semibold">
                    Total, {totals.count} {totals.count === 1 ? 'payment' : 'payments'}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    <Money paise={totals.base_paise} />
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    <Money paise={totals.gst_paise} />
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    <Money paise={totals.amount_paise} />
                  </TableCell>
                  <TableCell colSpan={5} />
                </TableRow>
              </TableFooter>
            </Table>
          </ScrollRegion>
        </>
      )}
      <Pager
        page={list.page}
        pageSize={list.page_size}
        total={list.total}
        hrefFor={(page) => hrefWithParams(PATH, filterParams({ ...withoutPage, page }))}
      />
    </>
  );
}

function RestaurantLink({ row }: { row: PaymentRow }) {
  return (
    <Link
      href={`/super/restaurants/${row.restaurant_id}#section-payments`}
      className="font-medium text-brand underline-offset-4 hover:underline"
    >
      {row.restaurant_name}
    </Link>
  );
}

function RazorpayId({ id }: { id: string | null }) {
  if (!id) return <>—</>;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs">
      {id}
      <CopyButton value={id} label={`Copy ${id}`} />
    </span>
  );
}

/** A payment on a phone: the same facts as a table row, stacked. */
function PaymentCard({ row }: { row: PaymentRow }) {
  const facts: [string, ReactNode][] = [
    ['Amount', <Money key="a" paise={row.base_paise} />],
    ['GST', <Money key="g" paise={row.gst_paise} />],
    ['Period', formatPeriod(row.period_start, row.period_end)],
    ['Razorpay ID', <RazorpayId key="r" id={row.razorpay_payment_id} />],
    ['Recorded by', paymentRecordedBy(row)],
    ['Notes', row.notes ?? '—'],
  ];
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <RestaurantLink row={row} />
        <Money paise={row.amount_paise} className="font-semibold text-ink" />
      </div>
      <p className="text-sm text-ink-muted">
        {formatDate(row.created_at)}, {paymentPlanLabel(row)}, {PAYMENT_METHOD_LABELS[row.method]}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {facts.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-ink-muted">{term}</dt>
            <dd className="min-w-0 break-words text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}
