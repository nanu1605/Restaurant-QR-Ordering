import Form from 'next/form';
import Link from 'next/link';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { hrefWithParams, type DatePreset } from '@/lib/date-range';

/**
 * The dates an analytics page shows (docs/SUPER_ADMIN_PLAN.md 12a): quick
 * ranges, any two dates, and with `compare`, the previous period too. Kept in
 * the URL (`from`, `to`, `compare`) so a view can be shared.
 */
export function DateRangeBar({
  path,
  presets,
  from,
  to,
  compare,
  notice,
}: {
  path: string;
  presets: DatePreset[];
  from: string;
  to: string;
  /** Whether the page compares; undefined leaves the choice out. */
  compare?: boolean;
  notice: string | null;
}) {
  const compareParam = compare ? '1' : undefined;
  return (
    <>
      <nav aria-label="Period" className="flex flex-wrap gap-2">
        {presets.map((preset) => {
          const active = from === preset.from && to === preset.to;
          return (
            <Link
              key={preset.key}
              href={hrefWithParams(path, {
                from: preset.from,
                to: preset.to,
                compare: compareParam,
              })}
              aria-current={active ? 'page' : undefined}
              className={buttonVariants({ variant: active ? 'default' : 'outline', size: 'sm' })}
            >
              {preset.label}
            </Link>
          );
        })}
      </nav>
      <Form
        key={`${from}-${to}-${compare}`}
        action={path}
        role="search"
        aria-label="Dates"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-3"
      >
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          From
          <Input type="date" name="from" defaultValue={from} className="h-11 md:h-9" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          To
          <Input type="date" name="to" defaultValue={to} className="h-11 md:h-9" />
        </label>
        {compare !== undefined && (
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink md:min-h-9">
            <input
              type="checkbox"
              name="compare"
              value="1"
              defaultChecked={compare}
              className="size-4 accent-brand"
            />
            Compare with the previous period
          </label>
        )}
        <Button type="submit" size="touch">
          Show
        </Button>
      </Form>
      {notice && (
        <p role="status" className="text-sm text-ink">
          {notice}
        </p>
      )}
    </>
  );
}
