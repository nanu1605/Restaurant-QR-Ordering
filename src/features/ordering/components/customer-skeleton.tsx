import { Skeleton } from '@/components/ui/skeleton';

/** Loading placeholder for the customer pages (spec §16.3). */
export function CustomerSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4 px-4 py-4">
      <Skeleton className="h-11 w-full" />
      <div className="flex gap-2">
        <Skeleton className="h-9 w-24 rounded-full" />
        <Skeleton className="h-9 w-20 rounded-full" />
        <Skeleton className="h-9 w-28 rounded-full" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex gap-3 py-2">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-3/5" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-4/5" />
          </div>
          <Skeleton className="h-11 w-28" />
        </div>
      ))}
    </div>
  );
}
