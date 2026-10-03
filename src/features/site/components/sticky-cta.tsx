'use client';

import { cn } from 'cn';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { buttonVariants } from '@/components/ui/button';

import { HERO } from '../content';

/**
 * On phones, the main call to action stays at the bottom of the screen once
 * the hero's own button has scrolled away.
 */
export function StickyCta() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const target = document.getElementById('hero-cta');
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => setShown(!entry!.isIntersecting));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      inert={!shown}
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 p-3 backdrop-blur-md transition-transform duration-300 md:hidden',
        shown ? 'translate-y-0' : 'translate-y-full',
      )}
    >
      <Link href="/contact" className={cn(buttonVariants({ size: 'touch' }), 'w-full')}>
        {HERO.primary}
      </Link>
    </div>
  );
}
