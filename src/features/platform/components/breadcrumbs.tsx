import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

export type Crumb = { href: string; label: string };

/** The pages above this one (docs/DECISIONS.md SA-3); the page's own heading names it. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="-mb-2 text-sm print:hidden">
      <ol className="flex flex-wrap items-center gap-1 text-ink-muted">
        {items.map(({ href, label }, index) => (
          <li key={href} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRight aria-hidden className="size-4 shrink-0" />}
            <Link
              href={href}
              className="inline-flex min-h-6 items-center truncate font-medium text-brand underline-offset-4 hover:underline"
            >
              {label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
