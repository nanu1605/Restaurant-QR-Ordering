'use client';

import { cn } from 'cn';

import { type BoardFilter, FILTER_LABELS } from '../board-view';

type BoardFiltersProps = {
  filters: BoardFilter[];
  value: BoardFilter;
  counts: Record<BoardFilter, number>;
  onChange: (filter: BoardFilter) => void;
};

/** Filter chips (spec §13.2): All / My tables / Needs approval / Unassigned / In progress / All served. */
export function BoardFilters({ filters, value, counts, onChange }: BoardFiltersProps) {
  return (
    <div role="group" aria-label="Show tables" className="flex gap-2 overflow-x-auto pb-1">
      {filters.map((filter) => {
        const active = filter === value;
        return (
          <button
            key={filter}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(filter)}
            className={cn(
              'inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-line bg-surface px-4 text-base font-medium text-ink hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              active && 'border-ring bg-primary text-primary-foreground hover:bg-primary',
            )}
          >
            {FILTER_LABELS[filter]}
            <span
              className={cn(
                'min-w-6 rounded-full px-1.5 text-sm tabular-nums',
                active ? 'bg-surface text-ink' : 'bg-paper text-ink-muted',
              )}
            >
              {counts[filter]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
