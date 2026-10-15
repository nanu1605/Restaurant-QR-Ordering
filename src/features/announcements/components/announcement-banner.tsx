import { Megaphone } from 'lucide-react';

import type { Lang } from '@/features/ordering/strings';

/**
 * An announcement from MenuMesh as a panel shows it (docs/DECISIONS.md
 * SA-82); also the team's preview, which isn't announced as it changes.
 * `children`: its Dismiss button.
 */
export function AnnouncementBanner({
  title,
  body,
  lang,
  preview = false,
  children,
}: {
  title: string;
  body: string;
  lang: Lang;
  preview?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      role={preview ? undefined : 'status'}
      className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border-l-4 border-brand bg-surface px-4 py-3 text-sm text-ink"
    >
      <Megaphone aria-hidden className="mt-0.5 size-4 shrink-0 text-brand" />
      <div lang={lang} className="min-w-0 flex-1 basis-56 [overflow-wrap:anywhere]">
        <p className="font-semibold">{title}</p>
        <p className="whitespace-pre-line">{body}</p>
      </div>
      {children}
    </div>
  );
}
