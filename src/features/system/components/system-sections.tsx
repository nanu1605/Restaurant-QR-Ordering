import { cn } from 'cn';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Money } from '@/components/shared/money';
import { Figure } from '@/features/platform/components/home-sections';
import { formatDateTime } from '@/features/platform/platform';
import { formatShare } from '@/features/growth/funnel';

import {
  emailKindLabel,
  formatBytes,
  formatMs,
  jobLabel,
  limitShare,
  NEAR_LIMIT,
  type SystemHealth,
} from '../system';
import { cell, EmailRows, Outcome, Table } from './parts';

const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';

/** A titled block of the page. */
export function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={id} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        {description && <p className="text-sm text-ink-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

// ─── Scheduled jobs ──────────────────────────────────────────────────────────
export function JobsSection({ system }: { system: SystemHealth }) {
  return (
    <Section
      id="jobs-heading"
      title="Scheduled jobs"
      description="Each step’s latest run. A job that hasn’t run for 26 hours, or a step that didn’t finish, is flagged here and on Home."
    >
      {system.jobs.length === 0 ? (
        <p className="text-sm text-ink-muted">No runs yet.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {system.jobs.map((job) => (
            <li
              key={job.job}
              className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-3 text-sm"
            >
              <span className="font-medium text-ink">{jobLabel(job.job)}</span>
              <span className="text-ink-muted">
                Last run {formatDateTime(job.last_at)}, took {formatMs(job.ms)}
              </span>
              {job.missing ? (
                <Outcome tone="bad">
                  Missed its run: nothing since {formatDateTime(job.last_at)}
                </Outcome>
              ) : job.failed + job.missing_steps > 0 ? (
                <Outcome tone="bad">
                  {[
                    job.failed > 0 && `${job.failed} of ${job.steps} steps failed`,
                    job.missing_steps > 0 && `${job.missing_steps} didn’t finish`,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </Outcome>
              ) : (
                <Outcome tone="ok">All {job.steps} steps fine</Outcome>
              )}
            </li>
          ))}
        </ul>
      )}
      {system.steps.length > 0 && (
        <Table label="Steps" headings={['Job', 'Step', 'Last run', 'Took', 'Result']}>
          {system.steps.map((step) => (
            <tr key={`${step.job}:${step.step}`} className="align-top">
              <td className={cell}>{jobLabel(step.job)}</td>
              <td className={cell}>{step.step}</td>
              <td className={cn(cell, 'whitespace-nowrap tabular-nums')}>
                {formatDateTime(step.started_at)}
              </td>
              <td className={cn(cell, 'whitespace-nowrap tabular-nums')}>{formatMs(step.ms)}</td>
              <td className={cn(cell, 'max-w-sm break-words')}>
                {step.missing ? (
                  <Outcome tone="bad">Didn’t finish in the latest run</Outcome>
                ) : step.ok ? (
                  <Outcome tone="ok">Done</Outcome>
                ) : (
                  <Outcome tone="bad">Failed: {step.detail}</Outcome>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {system.failures.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-brand">Latest failures this week</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {system.failures.map((failure) => (
              <li
                key={`${failure.job}:${failure.step}:${failure.started_at}`}
                className="break-words"
              >
                <span className="tabular-nums">{formatDateTime(failure.started_at)}</span>{' '}
                {jobLabel(failure.job)}, {failure.step}: {failure.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}

// ─── Webhooks ────────────────────────────────────────────────────────────────
export function WebhooksSection({ webhooks }: { webhooks: SystemHealth['webhooks'] }) {
  return (
    <Section id="webhooks-heading" title="Webhooks">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Figure label="Failed in 24 hours" href="/super/webhooks?status=failed">
          {webhooks.failed_24h}
        </Figure>
        <Figure label="Still failing" href="/super/webhooks?status=failed">
          {webhooks.failed_open}
        </Figure>
      </dl>
    </Section>
  );
}

// ─── Email ───────────────────────────────────────────────────────────────────
export function EmailSection({
  email,
  configured,
  bounces,
  lookup,
}: {
  email: SystemHealth['email'];
  configured: boolean;
  bounces: boolean;
  lookup: ReactNode;
}) {
  return (
    <Section
      id="email-heading"
      title="Email"
      description={
        <>
          {configured
            ? 'Sent through Resend.'
            : 'Not set up: RESEND_API_KEY or EMAIL_FROM is missing.'}{' '}
          {bounces
            ? 'Bounces and spam reports come back from Resend.'
            : 'Bounce reports are off until RESEND_WEBHOOK_SECRET is set.'}{' '}
          Kept 30 days, with addresses only as keyed hashes.
        </>
      }
    >
      {email.kinds.length > 0 && (
        <Table
          label="Emails in the last 24 hours"
          headings={[
            'Last 24 hours',
            'Sent',
            'Already sent',
            'Failed',
            'Bounced',
            'Marked as spam',
          ]}
          minWidth="min-w-[36rem]"
        >
          {email.kinds.map((kind) => (
            <tr key={kind.kind}>
              <th scope="row" className={cn(cell, 'font-normal')}>
                {emailKindLabel(kind.kind)}
              </th>
              {[kind.sent, kind.duplicate, kind.failed, kind.bounced, kind.complained].map(
                (value, index) => (
                  <td
                    key={index}
                    className={cn(
                      cell,
                      'tabular-nums',
                      index >= 2 && value > 0 && 'font-medium text-destructive',
                    )}
                  >
                    {value}
                  </td>
                ),
              )}
            </tr>
          ))}
        </Table>
      )}
      {lookup}
      {email.recent.length === 0 ? (
        <p className="text-sm text-ink-muted">No emails in the last 30 days.</p>
      ) : (
        <EmailRows rows={email.recent} label="Latest emails" />
      )}
    </Section>
  );
}

// ─── Space ───────────────────────────────────────────────────────────────────
function Usage({
  label,
  bytes,
  limitMb,
}: {
  label: string;
  bytes: number;
  limitMb: number | null;
}) {
  const share = limitShare(bytes, limitMb);
  const near = share !== null && share >= NEAR_LIMIT;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-3 text-sm">
      <span className="font-medium text-ink">{label}</span>
      <span className="text-ink tabular-nums">
        {formatBytes(bytes)}
        {share !== null &&
          ` of ${formatBytes(limitMb! * 1024 * 1024)} (${Math.round(share * 100)}%)`}
      </span>
      {share !== null && (
        <div aria-hidden className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full', near ? 'bg-destructive' : 'bg-brand')}
            style={{ width: `${Math.min(100, share * 100)}%` }}
          />
        </div>
      )}
      {near && <Outcome tone="warn">Over 80% of the plan’s limit</Outcome>}
    </div>
  );
}

export function SpaceSection({
  sizes,
  canEditLimits,
}: {
  sizes: SystemHealth['sizes'];
  canEditLimits: boolean;
}) {
  const storage = sizes.buckets.reduce((sum, bucket) => sum + bucket.bytes, 0);
  const noLimits = sizes.db_limit_mb === null || sizes.storage_limit_mb === null;
  return (
    <Section
      id="space-heading"
      title="Space"
      description={
        <>
          The database size is an estimate: Supabase also counts its logs and free space.
          {noLimits && (
            <>
              {' '}
              {canEditLimits ? (
                <Link href="/super/settings" className={linkClass}>
                  Enter the plan’s limits
                </Link>
              ) : (
                'An admin can enter the plan’s limits'
              )}{' '}
              to see how full each is.
            </>
          )}
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Usage label="Database" bytes={sizes.database_bytes} limitMb={sizes.db_limit_mb} />
        <Usage label="Storage" bytes={storage} limitMb={sizes.storage_limit_mb} />
      </div>
      {sizes.buckets.length > 0 && (
        <Table
          label="Storage by bucket"
          headings={['Bucket', 'Files', 'Size']}
          minWidth="min-w-[24rem]"
        >
          {sizes.buckets.map((bucket) => (
            <tr key={bucket.bucket}>
              <td className={cn(cell, 'font-mono text-xs')}>{bucket.bucket}</td>
              <td className={cn(cell, 'tabular-nums')}>{bucket.objects.toLocaleString('en-IN')}</td>
              <td className={cn(cell, 'tabular-nums')}>{formatBytes(bucket.bytes)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

// ─── Menu imports ────────────────────────────────────────────────────────────
export function MenuImportsSection({ imports }: { imports: SystemHealth['menu_imports'] }) {
  const finished = imports.imported + imports.failed + imports.discarded;
  return (
    <Section
      id="imports-heading"
      title="Menu imports this month"
      description="Failed out of the finished ones; a failure is usually a photo the model couldn’t read."
    >
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Figure label="Imports" note={`${imports.photo} photo, ${imports.csv} CSV`}>
          {imports.imports}
        </Figure>
        <Figure label="Failed">{formatShare(imports.failed, finished)}</Figure>
        <Figure label="Still open">{imports.open}</Figure>
        <Figure
          label="AI cost"
          note={
            imports.cost_unknown > 0 ? `Plus ${imports.cost_unknown} of unknown cost` : undefined
          }
        >
          <Money paise={imports.cost_paise} />
        </Figure>
      </dl>
    </Section>
  );
}
