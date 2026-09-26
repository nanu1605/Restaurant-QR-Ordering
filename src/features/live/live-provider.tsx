'use client';

import type { RealtimeChannel } from '@supabase/supabase-js';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { ConnectionState } from '@/components/shared/connection-indicator';
import { createClient } from '@/lib/supabase/browser';

import { type ChannelStatus, connectionState, EVENT_DEBOUNCE_MS, LIVE_TABLES } from './connection';
import { BOARD_MUTATION_KEY, getQueryClient, MENU_MUTATION_KEY } from './query-client';

type LiveContextValue = {
  restaurantId: string;
  memberId: string;
  connection: ConnectionState;
};

const LiveContext = createContext<LiveContextValue | null>(null);

/** The live screens' shared state: who is looking and whether updates are flowing. */
export function useLive(): LiveContextValue {
  const value = use(LiveContext);
  if (!value) throw new Error('useLive must be used inside <LiveProvider>');
  return value;
}

/** No network: buttons that need the server are disabled (docs/DECISIONS.md P9-5). */
export function useOffline(): boolean {
  return useLive().connection === 'offline';
}

type LiveProviderProps = {
  restaurantId: string;
  memberId: string;
  children: ReactNode;
};

/**
 * TanStack Query plus one Realtime channel per restaurant (spec §12,
 * docs/DECISIONS.md P4-2). Events never patch the screen: they only tell the
 * queries to refetch, 300 ms after the last one.
 */
export function LiveProvider({ restaurantId, memberId, children }: LiveProviderProps) {
  useEffect(() => {
    // Installable staff app with an offline page (docs/DECISIONS.md P9-6).
    navigator.serviceWorker?.register('/sw.js').catch(() => {});
  }, []);
  return (
    <QueryClientProvider client={getQueryClient()}>
      <RealtimeChannelBridge restaurantId={restaurantId} memberId={memberId}>
        {children}
      </RealtimeChannelBridge>
    </QueryClientProvider>
  );
}

let channelCount = 0;

function RealtimeChannelBridge({ restaurantId, memberId, children }: LiveProviderProps) {
  const queryClient = useQueryClient();
  const [channelStatus, setChannelStatus] = useState<ChannelStatus>('connecting');
  const online = useOnline();

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let menuChanged = false;

    const refetch = () => {
      // While this device is changing the board or the menu, its last change refetches.
      if (queryClient.isMutating({ mutationKey: BOARD_MUTATION_KEY }) === 0) {
        void queryClient.invalidateQueries({ queryKey: ['board'] });
      }
      void queryClient.invalidateQueries({ queryKey: ['billing'] });
      if (menuChanged && queryClient.isMutating({ mutationKey: MENU_MUTATION_KEY }) === 0) {
        void queryClient.invalidateQueries({ queryKey: ['menu'] });
        menuChanged = false;
      }
    };

    const onEvent = (table: string) => {
      if (table === 'menu_items') menuChanged = true;
      clearTimeout(timer);
      timer = setTimeout(refetch, EVENT_DEBOUNCE_MS);
    };

    void (async () => {
      // Join with the signed-in user's token so RLS lets their events through.
      await supabase.realtime.setAuth();
      if (cancelled) return;
      channelCount += 1;
      channel = supabase.channel(`restaurant:${restaurantId}:${channelCount}`, {
        // SUBSCRIBED only once the database side is listening too.
        config: { postgres_changes_options: { wait: true } },
      });
      for (const table of LIVE_TABLES) {
        channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table, filter: `restaurant_id=eq.${restaurantId}` },
          () => onEvent(table),
        );
      }
      channel.subscribe((status) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') {
          setChannelStatus('subscribed');
          // Catch up on anything that happened while we weren't listening.
          menuChanged = true;
          refetch();
        } else {
          setChannelStatus('error');
        }
      });
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [restaurantId, queryClient]);

  const value: LiveContextValue = {
    restaurantId,
    memberId,
    connection: connectionState(online, channelStatus),
  };
  return <LiveContext value={value}>{children}</LiveContext>;
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}
