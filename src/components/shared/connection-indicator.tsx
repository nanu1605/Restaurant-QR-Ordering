import { cn } from 'cn';

export type ConnectionState = 'live' | 'reconnecting' | 'offline';

const DOTS: Record<ConnectionState, string> = {
  live: 'bg-status-served',
  reconnecting: 'bg-status-preparing animate-pulse',
  offline: 'bg-status-void',
};

const LABELS: Record<ConnectionState, string> = {
  live: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
};

type ConnectionIndicatorProps = {
  state: ConnectionState;
  /** English unless the worker panel passes its own words. */
  labels?: Record<ConnectionState, string>;
  className?: string;
};

/**
 * Realtime connection status for the staff/admin header (spec §12).
 * Presentational only for now; Phase 4 drives `state` from the Realtime channel.
 */
export function ConnectionIndicator({
  state,
  labels = LABELS,
  className,
}: ConnectionIndicatorProps) {
  const dot = DOTS[state];

  return (
    <span
      role="status"
      aria-live="polite"
      data-state={state}
      className={cn('inline-flex items-center gap-2 text-sm font-medium text-ink', className)}
    >
      <span aria-hidden className={cn('size-2.5 rounded-full', dot)} />
      {labels[state]}
    </span>
  );
}
