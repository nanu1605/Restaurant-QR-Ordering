import { cn } from 'cn';

export type ConnectionState = 'live' | 'reconnecting' | 'offline';

const STATES: Record<ConnectionState, { label: string; dot: string }> = {
  live: { label: 'Live', dot: 'bg-status-served' },
  reconnecting: { label: 'Reconnecting…', dot: 'bg-status-preparing animate-pulse' },
  offline: { label: 'Offline', dot: 'bg-status-void' },
};

type ConnectionIndicatorProps = {
  state: ConnectionState;
  className?: string;
};

/**
 * Realtime connection status for the staff/admin header (spec §12).
 * Presentational only for now; Phase 4 drives `state` from the Realtime channel.
 */
export function ConnectionIndicator({ state, className }: ConnectionIndicatorProps) {
  const { label, dot } = STATES[state];

  return (
    <span
      role="status"
      aria-live="polite"
      data-state={state}
      className={cn('inline-flex items-center gap-2 text-sm font-medium text-ink', className)}
    >
      <span aria-hidden className={cn('size-2.5 rounded-full', dot)} />
      {label}
    </span>
  );
}
