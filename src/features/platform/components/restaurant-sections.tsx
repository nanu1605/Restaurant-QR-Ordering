import type { ReactNode } from 'react';

/** A titled box on a restaurant's page; `#section-<title>` links to it. */
export function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  /** A link or button beside the title. */
  action?: ReactNode;
}) {
  const id = `section-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-base font-semibold text-ink">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Facts({ facts, label }: { facts: [string, ReactNode][]; label?: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {facts.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-ink-muted">{term}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere] text-ink tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
