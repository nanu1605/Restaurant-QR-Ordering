import { cn } from 'cn';
import { Lock, TriangleAlert } from 'lucide-react';
import Link from 'next/link';

import type { AccessBanner as Banner } from '@/features/subscriptions/access-banner';

export function AccessBanner({ banner }: { banner: Banner }) {
  const blocked = banner.tone === 'blocked';
  const Icon = blocked ? Lock : TriangleAlert;

  return (
    <div
      role={blocked ? 'alert' : 'status'}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border-l-4 bg-surface px-4 py-3 text-sm text-ink',
        blocked ? 'border-status-void' : 'border-status-preparing',
      )}
    >
      <Icon
        aria-hidden
        className={cn('size-4 shrink-0', blocked ? 'text-status-void' : 'text-status-preparing')}
      />
      <p className="flex-1">{banner.text}</p>
      {banner.action && (
        <Link
          href={banner.action.href}
          className="font-medium text-brand underline-offset-4 hover:underline"
        >
          {banner.action.label}
        </Link>
      )}
    </div>
  );
}
