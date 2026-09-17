'use client';

import { cn } from 'cn';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useId, type FormEvent } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { PAYMENT_MODE_LABELS, type TotalOrders } from '../bill';
import { datePresets, filterParams, totalOrdersHref, type TotalOrdersFilters } from '../schemas';

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

type TotalOrdersFiltersFormProps = {
  data: Pick<TotalOrders, 'today' | 'from' | 'to' | 'view' | 'tables' | 'waiters'>;
  filters: TotalOrdersFilters;
};

/**
 * Total orders filters (spec §13.3): date range with business-day presets,
 * table, waiter, payment status and mode, invoice search, void bills, and the
 * "Closed without bill" view. Everything lives in the URL.
 */
export function TotalOrdersFiltersForm({ data, filters }: TotalOrdersFiltersFormProps) {
  const router = useRouter();
  const pathname = usePathname();
  const ids = useId();
  const current = filterParams(filters);
  const closedView = data.view === 'closed_unbilled';

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };
    router.push(
      totalOrdersHref(pathname, {
        ...current,
        from: text('from'),
        to: text('to'),
        table: text('table'),
        waiter: text('waiter'),
        payment: closedView ? undefined : text('payment'),
        mode: closedView ? undefined : text('mode'),
        invoice: closedView ? undefined : text('invoice'),
        void: form.get('void') === 'hide' ? 'hide' : undefined,
      }),
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <nav aria-label="Total orders views" className="flex flex-wrap gap-2">
        {[
          { key: 'bills', label: 'Bills', view: undefined },
          { key: 'closed', label: 'Closed without bill', view: 'closed' },
        ].map((tab) => {
          const selected = (tab.view === 'closed') === closedView;
          return (
            <Link
              key={tab.key}
              href={totalOrdersHref(pathname, {
                from: current.from,
                to: current.to,
                table: current.table,
                waiter: current.waiter,
                view: tab.view,
              })}
              aria-current={selected ? 'page' : undefined}
              className={buttonVariants({
                variant: selected ? 'default' : 'outline',
                size: 'touch',
              })}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Date presets">
        {datePresets(data.today).map((preset) => {
          const selected = preset.from === data.from && preset.to === data.to;
          return (
            <Link
              key={preset.key}
              href={totalOrdersHref(pathname, { ...current, from: preset.from, to: preset.to })}
              aria-current={selected ? 'true' : undefined}
              className={cn(
                buttonVariants({ variant: 'outline', size: 'touch' }),
                selected && 'border-2 border-ring',
              )}
            >
              {preset.label}
            </Link>
          );
        })}
      </div>

      {/* Remount when the URL changes so the fields show the applied filters. */}
      <form
        key={JSON.stringify(current)}
        onSubmit={apply}
        className="grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          From
          <Input
            type="date"
            name="from"
            defaultValue={data.from}
            max={data.today}
            className="h-11"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          To
          <Input type="date" name="to" defaultValue={data.to} max={data.today} className="h-11" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Table
          <select name="table" defaultValue={filters.table_id ?? ''} className={SELECT_CLASS}>
            <option value="">All tables</option>
            {data.tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Waiter
          <select name="waiter" defaultValue={filters.waiter_id ?? ''} className={SELECT_CLASS}>
            <option value="">All waiters</option>
            {data.waiters.map((waiter) => (
              <option key={waiter.id} value={waiter.id}>
                {waiter.isActive ? waiter.name : `${waiter.name} (deleted)`}
              </option>
            ))}
          </select>
        </label>
        {!closedView && (
          <>
            <label className="flex flex-col gap-1 text-sm font-medium text-ink">
              Payment
              <select
                name="payment"
                defaultValue={filters.payment_status ?? ''}
                className={SELECT_CLASS}
              >
                <option value="">Paid and unpaid</option>
                <option value="paid">Paid</option>
                <option value="unpaid">Unpaid</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-ink">
              Payment mode
              <select
                name="mode"
                defaultValue={filters.payment_mode ?? ''}
                className={SELECT_CLASS}
              >
                <option value="">Any mode</option>
                {Object.entries(PAYMENT_MODE_LABELS).map(([mode, label]) => (
                  <option key={mode} value={mode}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-ink">
              Invoice number
              <Input
                type="search"
                name="invoice"
                defaultValue={filters.invoice ?? ''}
                maxLength={40}
                placeholder="00042"
                className="h-11"
              />
            </label>
            <label
              htmlFor={`${ids}-void`}
              className="flex min-h-11 cursor-pointer items-center gap-3 self-end text-base text-ink"
            >
              <input
                id={`${ids}-void`}
                type="checkbox"
                name="void"
                value="hide"
                defaultChecked={filters.show_void === false}
                className="size-5 accent-primary"
              />
              Hide void bills
            </label>
          </>
        )}
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
          <Button type="submit" size="touch">
            Apply filters
          </Button>
          <Link
            href={totalOrdersHref(pathname, { view: current.view })}
            className={buttonVariants({ variant: 'ghost', size: 'touch' })}
          >
            Clear filters
          </Link>
        </div>
      </form>
    </div>
  );
}
