import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';

const SECTIONS = [
  { href: '/super/leads', label: 'Pipeline' },
  { href: '/super/leads/signups', label: 'Unfinished signups' },
] as const;

/** The Leads pages: the pipeline and the signups that stopped part-way. */
export function LeadsSections({ current }: { current: (typeof SECTIONS)[number]['href'] }) {
  return (
    <nav aria-label="Leads sections" className="flex flex-wrap gap-2 border-b border-line pb-3">
      {SECTIONS.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          aria-current={href === current ? 'page' : undefined}
          className={buttonVariants({
            variant: href === current ? 'default' : 'ghost',
            size: 'touch',
          })}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
