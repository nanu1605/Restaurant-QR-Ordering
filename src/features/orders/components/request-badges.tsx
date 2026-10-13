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

type RequestWords = Record<ServiceRequestType, { badge: string }> & {
  acknowledgedBadge: string;
};

const WORDS: RequestWords = { ...REQUESTS, acknowledgedBadge: ' (acknowledged)' };

/**
 * "Calling" / "Bill requested" on a table card (spec §10.4, P9-2), in English
 * unless the worker panel passes its own words.
 */
export function RequestBadges({
  requests,
  words = WORDS,
}: {
  requests: BoardRequest[];
  words?: RequestWords;
}) {
  return requests.map((request) => {
    const { icon: Icon } = REQUESTS[request.type];
    const { badge } = words[request.type];
    return (
      <span
        key={request.id}
        data-request={request.type}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-attention px-2 text-base font-semibold whitespace-nowrap text-attention"
      >
        <Icon aria-hidden className="size-4 shrink-0" strokeWidth={2.25} />
        {badge}
        {request.status === 'acknowledged' && (
          <span className="sr-only">{words.acknowledgedBadge}</span>
        )}
      </span>
    );
  });
}
