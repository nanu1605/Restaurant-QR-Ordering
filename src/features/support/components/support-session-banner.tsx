import { Headset } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';

import { endSupportSession } from '../access-actions';
import { untilText } from '../support-access';

/** On every admin page while a team member works in a support session (SA-48). */
export function SupportSessionBanner({
  restaurantId,
  restaurantName,
  endsAt,
  timezone,
}: {
  restaurantId: string;
  restaurantName: string;
  endsAt: string;
  timezone: string;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border-l-4 border-brand bg-surface px-4 py-3 text-sm text-ink"
    >
      <Headset aria-hidden className="size-4 shrink-0 text-brand" />
      <p className="min-w-0 flex-1">
        Support session in {restaurantName}. Ends at {untilText(endsAt, timezone)}.
      </p>
      <Link
        href={`/super/restaurants/${restaurantId}`}
        className="inline-flex min-h-11 items-center font-medium text-brand underline-offset-4 hover:underline md:min-h-6"
      >
        Back to MenuMesh admin
      </Link>
      <form action={endSupportSession}>
        <Button type="submit" variant="outline" size="touch">
          End session
        </Button>
      </form>
    </div>
  );
}
