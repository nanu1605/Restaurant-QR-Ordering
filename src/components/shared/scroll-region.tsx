import { cn } from 'cn';
import type { ReactNode } from 'react';

/**
 * A wide table that scrolls sideways on narrow screens. It takes keyboard
 * focus so arrow keys can scroll it, and it is positioned so screen-reader
 * text inside can't push the page wider (docs/DECISIONS.md P6-14, B-6).
 */
export function ScrollRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        'relative min-w-0 overflow-x-auto rounded-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        className,
      )}
    >
      {children}
    </div>
  );
}
