import { cn } from 'cn';
import { CircleAlert, CircleCheck, CircleX } from 'lucide-react';
import type { ReactNode } from 'react';

import { ScrollRegion } from '@/components/shared/scroll-region';
import { formatDateTime } from '@/features/platform/platform';

import { EMAIL_STATUS_LABELS, emailKindLabel, type EmailRow } from '../system';

export const cell = 'px-3 py-2';

/** A result in words with an icon: colour is never the only signal. */
export function Outcome({ tone, children }: { tone: 'ok' | 'bad' | 'warn'; children: ReactNode }) {
  const Icon = tone === 'ok' ? CircleCheck : tone === 'bad' ? CircleX : CircleAlert;
  return (
    <span
      className={cn(
        'inline-flex items-start gap-1.5',
        tone === 'ok' ? 'text-ink' : 'font-medium text-destructive',
      )}
    >
      <Icon
        aria-hidden
        className={cn('mt-0.5 size-4 shrink-0', tone === 'ok' && 'text-status-served')}
      />
      <span>{children}</span>
    </span>
  );
}

export function Table({
  label,
  headings,
  children,
  minWidth = 'min-w-[40rem]',
}: {
  label: string;
  headings: string[];
  children: ReactNode;
  minWidth?: string;
}) {
  return (
    <ScrollRegion label={label} className="rounded-lg border border-line bg-surface">
      <table className={cn('w-full text-left text-sm text-ink', minWidth)}>
        <caption className="sr-only">{label}</caption>
        <thead className="border-b border-line text-ink-muted">
          <tr>
            {headings.map((heading) => (
              <th key={heading} scope="col" className={cn(cell, 'font-medium')}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </ScrollRegion>
  );
}

export function EmailRows({ rows, label }: { rows: EmailRow[]; label: string }) {
  return (
    <Table label={label} headings={['Time', 'Email', 'Result', 'To', 'Resend id']}>
      {rows.map((row) => (
        <tr key={row.id} className="align-top">
          <td className={cn(cell, 'whitespace-nowrap tabular-nums')}>
            {formatDateTime(row.created_at)}
          </td>
          <td className={cell}>{emailKindLabel(row.kind)}</td>
          <td className={cn(cell, 'max-w-sm break-words')}>
            <Outcome tone={row.status === 'sent' || row.status === 'duplicate' ? 'ok' : 'bad'}>
              {EMAIL_STATUS_LABELS[row.status]}
              {row.error && `: ${row.error}`}
            </Outcome>
          </td>
          <td className={cn(cell, 'tabular-nums')}>
            {row.recipients === 1 ? '1 address' : `${row.recipients} addresses`}
          </td>
          <td className={cn(cell, 'font-mono text-xs break-all')}>{row.provider_id ?? '—'}</td>
        </tr>
      ))}
    </Table>
  );
}
