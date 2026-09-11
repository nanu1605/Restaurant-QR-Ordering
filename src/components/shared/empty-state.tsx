import { cn } from 'cn';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

type EmptyStateProps = {
  title: string;
  /** Tell the user what to do next, e.g. "Add tables to print your QR codes." */
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, icon: Icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line px-6 py-10 text-center',
        className,
      )}
    >
      {Icon && <Icon aria-hidden className="size-8 text-ink-muted" strokeWidth={1.75} />}
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-base font-semibold text-ink">{title}</p>
        {description && <p className="text-sm text-ink-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
