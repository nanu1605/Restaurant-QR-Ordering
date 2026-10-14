import { ImageIcon } from 'lucide-react';

import { formatBillDate } from '@/features/ordering/format';

import {
  CONTACT_METHOD_LABELS,
  OWNER_STATUS_LABELS,
  SUPPORT_TOPIC_LABELS,
  type OwnerSupportRequest,
} from '../support';
import { SupportStatusBadge } from './support-badges';

/**
 * The restaurant's requests and where each stands (docs/DECISIONS.md SA-42):
 * the status in the restaurant's words, with every change and when.
 */
export function OwnerRequests({
  requests,
  timezone,
}: {
  requests: OwnerSupportRequest[];
  timezone: string;
}) {
  if (requests.length === 0) {
    return <p className="text-sm text-ink-muted">No requests yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {requests.map((request) => (
        <li
          key={request.id}
          aria-label={`${SUPPORT_TOPIC_LABELS[request.topic]}, ${formatBillDate(request.created_at, timezone)}`}
          className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-ink">{SUPPORT_TOPIC_LABELS[request.topic]}</span>
            <SupportStatusBadge status={request.status} labels={OWNER_STATUS_LABELS} />
          </div>
          <p className="line-clamp-4 text-sm whitespace-pre-line text-ink">{request.message}</p>
          <p className="flex flex-wrap items-center gap-x-3 text-xs text-ink-muted">
            <span>
              Sent by {request.created_by_name}, {formatBillDate(request.created_at, timezone)}
            </span>
            <span>
              {CONTACT_METHOD_LABELS[request.contact_method]}: {request.contact}
            </span>
            {request.has_screenshot && (
              <span className="inline-flex items-center gap-1">
                <ImageIcon aria-hidden className="size-3.5" /> Screenshot sent
              </span>
            )}
          </p>
          {request.history.length > 0 && (
            <ol
              aria-label="Status changes"
              className="flex flex-col gap-0.5 text-xs text-ink-muted"
            >
              {request.history.map((change) => (
                <li key={change.at}>
                  {OWNER_STATUS_LABELS[change.status]}: {formatBillDate(change.at, timezone)}
                </li>
              ))}
            </ol>
          )}
        </li>
      ))}
    </ul>
  );
}
