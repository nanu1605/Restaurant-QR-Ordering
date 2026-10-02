import { cn } from 'cn';

import { LOGO_PATH } from '@/lib/app-icon';
import { APP_NAME } from '@/lib/config';

/** The "M" mark and the product name, as on the app icon. */
export function SiteLogo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-lg font-bold text-ink', className)}>
      <svg viewBox="0 0 24 24" aria-hidden className="size-8 shrink-0 rounded-lg bg-brand p-1.5">
        <path
          d={LOGO_PATH}
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {APP_NAME}
    </span>
  );
}
