import { cn } from 'cn';
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';

type PagerProps = {
  page: number;
  pageSize: number;
  total: number;
  /** The link to a page of the same list. */
  hrefFor: (page: number) => string;
};

/** Previous/next links under a paged list, with "51–100 of 230". */
export function Pager({ page, pageSize, total, hrefFor }: PagerProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3">
      <p className="text-sm text-ink-muted">
        {first}–{last} of {total}
      </p>
      <div className="flex gap-2">
        <Link
          href={hrefFor(Math.max(1, page - 1))}
          aria-disabled={page === 1}
          tabIndex={page === 1 ? -1 : undefined}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'touch' }),
            page === 1 && 'pointer-events-none opacity-50',
          )}
        >
          Previous
        </Link>
        <Link
          href={hrefFor(Math.min(pages, page + 1))}
          aria-disabled={page === pages}
          tabIndex={page === pages ? -1 : undefined}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'touch' }),
            page === pages && 'pointer-events-none opacity-50',
          )}
        >
          Next
        </Link>
      </div>
    </nav>
  );
}
