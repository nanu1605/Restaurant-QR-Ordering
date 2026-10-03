import { BellRing, ReceiptText, type LucideIcon } from 'lucide-react';

import type { BoardRequest, ServiceRequestType } from '../board';

/** Pure, so the website's demo can show them without the live board. */
export const REQUESTS: Record<
  ServiceRequestType,
  { icon: LucideIcon; badge: string; line: string }
> = {
  call_waiter: { icon: BellRing, badge: 'Calling', line: 'Calling a waiter' },
  request_bill: { icon: ReceiptText, badge: 'Bill requested', line: 'Asked for the bill' },
};

/** "Calling" / "Bill requested" on a table card (spec §10.4, P9-2). */
export function RequestBadges({ requests }: { requests: BoardRequest[] }) {
  return requests.map((request) => {
    const { icon: Icon, badge } = REQUESTS[request.type];
    return (
      <span
        key={request.id}
        data-request={request.type}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-attention px-2 text-base font-semibold whitespace-nowrap text-attention"
      >
        <Icon aria-hidden className="size-4 shrink-0" strokeWidth={2.25} />
        {badge}
        {request.status === 'acknowledged' && <span className="sr-only"> (acknowledged)</span>}
      </span>
    );
  });
}
