import { Skeleton } from '@/components/ui/skeleton';

export default function StaffLoading() {
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="sr-only">Loading…</span>
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-11 w-28 rounded-full" />
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-36 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
