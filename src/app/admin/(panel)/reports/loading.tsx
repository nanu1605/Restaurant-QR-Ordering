import { Skeleton } from '@/components/ui/skeleton';

/** Shown while a report is worked out: a tab, a range or a page was chosen. */
export default function ReportsLoading() {
  return (
    <div role="status" className="flex flex-col gap-4">
      <span className="sr-only">Loading the report…</span>
      <Skeleton className="h-9 w-40" />
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-11 w-24" />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-11 w-28" />
        ))}
      </div>
      <Skeleton className="h-36 rounded-lg" />
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
