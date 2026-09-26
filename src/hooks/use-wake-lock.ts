'use client';

import { useEffect } from 'react';

/**
 * Keeps the screen on while a live screen is open (spec §19 Phase 9), so a
 * board tablet doesn't dim mid-service. Browsers drop the lock when the tab is
 * hidden; it is taken again on return. Does nothing where unsupported.
 */
export function useWakeLock() {
  useEffect(() => {
    if (!('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let active = true;

    const request = async () => {
      if (document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      try {
        lock = await navigator.wakeLock.request('screen');
        if (!active) void lock.release();
      } catch {
        // Refused (battery saver, say): the screen dims as usual.
      }
    };

    const onVisibility = () => void request();
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      void lock?.release();
    };
  }, []);
}
