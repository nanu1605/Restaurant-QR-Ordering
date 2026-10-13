'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useStaffStrings } from '@/features/orders/staff-lang';

// Inside the layout, so in the login's language.
export default function StaffLoading() {
  const t = useStaffStrings();
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="sr-only">{t.loading}</span>
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-11 w-28 rounded-full" />
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-36 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
