'use client';

import { LazyMotion, MotionConfig, domAnimation } from 'motion/react';
import { useSyncExternalStore } from 'react';

/**
 * The website's animations (docs/DECISIONS.md W-3): `m` components with the
 * small dom-animation bundle only (`strict` refuses the full `motion` ones).
 * With the OS "reduce motion" setting, movement becomes instant.
 */
export function SiteMotion({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}

const REDUCE = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void) {
  const query = window.matchMedia(REDUCE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** The OS "reduce motion" setting; false on the server, so hydration matches. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(REDUCE).matches,
    () => false,
  );
}
