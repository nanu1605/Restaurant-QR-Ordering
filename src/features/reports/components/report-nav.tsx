'use client';

import { cn } from 'cn';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { useId, type FormEvent } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRouter } from 'next/navigation';

import { datePresets } from '@/lib/date-range';

import {
  exportHref,
  REPORT_LABELS,
  REPORTS,
  type ReportKey,
  type ReportParams,
  reportHref,
} from '../params';
import { ACTIVITY_LABELS, ACTIVITY_KINDS, type ActivityKind } from '../report';

/** The report tabs, the date range and the CSV links (spec §13.3 Reports). */

export function ReportTabs({
  params,
  allowed,
}: {
  params: ReportParams;
  /** Reports the plan includes; the others are still listed, with a lock hint. */
  allowed: Record<ReportKey, boolean>;
}) {
  return (
    <nav aria-label="Reports" className="-mx-1 min-w-0 overflow-x-auto px-1 pb-1">
      <ul className="flex min-w-max gap-2">
        {REPORTS.map((report) => {
          const current = report === params.report;
          return (
            <li key={report}>
              <Link
                href={reportHref(params, { report })}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  buttonVariants({ variant: current ? 'default' : 'outline', size: 'touch' }),
                  !allowed[report] && !current && 'text-ink-muted',
                )}
              >
                {REPORT_LABELS[report]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

type ReportRangeProps = {
  params: ReportParams;
  today: string;
  from: string;
  to: string;
  /** Starter: today or yesterday only, so the custom dates are hidden. */
  basic?: boolean;
};

export function ReportRange({ params, today, from, to, basic = false }: ReportRangeProps) {
  const router = useRouter();
  const fromId = useId();
  const toId = useId();
  const presets = datePresets(today).filter((preset) => !basic || preset.key !== 'week');
  const visible = basic
    ? presets.filter((p) => p.key === 'today' || p.key === 'yesterday')
    : presets;

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    router.push(
      reportHref(params, {
        from: String(data.get('from') ?? ''),
        to: String(data.get('to') ?? ''),
      }),
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div role="group" aria-label="Date presets" className="flex flex-wrap gap-2">
        {visible.map((preset) => {
          const selected = preset.from === from && preset.to === to;
          return (
            <Link
              key={preset.key}
              href={reportHref(params, { from: preset.from, to: preset.to })}
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
      {!basic && (
        <form onSubmit={apply} key={`${from}-${to}`} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={fromId} className="text-sm text-ink-muted">
              From
            </label>
            <Input
              id={fromId}
              type="date"
              name="from"
              defaultValue={from}
              max={today}
              className="h-11"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={toId} className="text-sm text-ink-muted">
              To
            </label>
            <Input id={toId} type="date" name="to" defaultValue={to} max={today} className="h-11" />
          </div>
          <Button type="submit" variant="outline" size="touch">
            Show
          </Button>
        </form>
      )}
    </div>
  );
}

/** Which activity log is shown (spec §19 Phase 6 logs). */
export function ActivityKindTabs({ params }: { params: ReportParams }) {
  return (
    <div role="group" aria-label="Activity" className="flex flex-wrap gap-2">
      {ACTIVITY_KINDS.map((kind: ActivityKind) => {
        const current = kind === params.kind;
        return (
          <Link
            key={kind}
            href={reportHref(params, { kind })}
            aria-current={current ? 'true' : undefined}
            className={cn(
              buttonVariants({ variant: 'outline', size: 'touch' }),
              current && 'border-2 border-ring',
            )}
          >
            {ACTIVITY_LABELS[kind]}
          </Link>
        );
      })}
    </div>
  );
}

type ExportLinkProps = {
  report: string;
  from: string;
  to: string;
  kind?: ActivityKind;
  label: string;
  canExport: boolean;
};

/** A CSV download, or a short note when the plan doesn't include exports. */
export function ExportLink({ report, from, to, kind, label, canExport }: ExportLinkProps) {
  if (!canExport) return null;
  return (
    <Link
      href={exportHref(report, { from, to }, kind)}
      prefetch={false}
      download
      className={buttonVariants({ variant: 'outline', size: 'touch' })}
    >
      <Download aria-hidden /> {label}
    </Link>
  );
}

/** Paging for the activity logs, mirroring Total orders. */
export function ReportPager({
  params,
  page,
  pageSize,
  total,
}: {
  params: ReportParams;
  page: number;
  pageSize: number;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3">
      <p className="text-sm text-ink-muted">
        {first}–{last} of {total}
      </p>
      <div className="flex gap-2">
        <Link
          href={reportHref(params, { page: Math.max(1, page - 1) })}
          aria-disabled={page === 1}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'touch' }),
            page === 1 && 'pointer-events-none opacity-50',
          )}
        >
          Previous
        </Link>
        <Link
          href={reportHref(params, { page: Math.min(pages, page + 1) })}
          aria-disabled={page === pages}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'touch' }),
            page === pages && 'pointer-events-none opacity-50',
          )}
        >
          Next
        </Link>
      </div>
    </nav>
  );
}
