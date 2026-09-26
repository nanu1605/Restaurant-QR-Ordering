import type { ConnectionState } from '@/components/shared/connection-indicator';

/** Where the restaurant's Realtime channel is. */
export type ChannelStatus = 'connecting' | 'subscribed' | 'error';

/**
 * The header indicator (spec §12): Offline when the device has no network,
 * Live once the channel is subscribed, Reconnecting… otherwise.
 */
export function connectionState(online: boolean, channel: ChannelStatus): ConnectionState {
  if (!online) return 'offline';
  return channel === 'subscribed' ? 'live' : 'reconnecting';
}

/** The tables in the supabase_realtime publication (spec §8.11). */
export const LIVE_TABLES = [
  'orders',
  'order_items',
  'table_sessions',
  'bills',
  'menu_items',
  'waiters',
  'service_requests',
] as const;

/** Events are bunched for this long before the board refetches (spec §12). */
export const EVENT_DEBOUNCE_MS = 300;
