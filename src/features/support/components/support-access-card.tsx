'use client';

import { useId, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { formatBillDate } from '@/features/ordering/format';

import { allowSupportAccess, endSupportAccess } from '../access-actions';
import type { SupportSessionHistory, SupportWindow } from '../access-queries';
import {
  SUPPORT_ACCESS_TEXT,
  SUPPORT_HOURS,
  untilText,
  type SupportHours,
} from '../support-access';

/**
 * Settings, for the owner (docs/SUPER_ADMIN_PLAN.md 13c, docs/DECISIONS.md
 * SA-47, SA-52): let MenuMesh support in for a while, end it, and see every
 * change made in each session.
 */
export function SupportAccessCard({
  open,
  history,
  truncated,
  timezone,
}: {
  open: (SupportWindow & { until: string }) | null;
  history: SupportSessionHistory[];
  truncated: boolean;
  timezone: string;
}) {
  const ids = useId();
  const [hours, setHours] = useState<SupportHours>(1);
  const [pending, startTransition] = useTransition();

  function allow() {
    startTransition(async () => {
      const result = await allowSupportAccess(hours);
      if (result.ok) {
        toast.success(`MenuMesh support can sign in until ${untilText(result.data, timezone)}.`);
      } else {
        toast.error(result.error);
      }
    });
  }

  function end() {
    startTransition(async () => {
      const result = await endSupportAccess();
      if (result.ok) toast.success('Support access ended');
      else toast.error(result.error);
    });
  }

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 md:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${ids}-title`} className="text-base font-semibold text-ink">
          MenuMesh support access
        </h2>
        <p className="max-w-prose text-sm text-ink-muted">{SUPPORT_ACCESS_TEXT}</p>
      </div>

      {open ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="min-w-0 flex-1 text-sm text-ink">
            {open.staffName
              ? `${open.staffName} from MenuMesh support is working in your restaurant until ${open.until}.`
              : `MenuMesh support can sign in until ${open.until}. No one has signed in yet.`}
          </p>
          <Button variant="outline" size="touch" onClick={end} disabled={pending}>
            {pending ? 'Ending…' : 'End access now'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend id={`${ids}-hours`} className="mb-1 text-sm font-semibold text-ink">
              Allow for
            </legend>
            <RadioGroup
              aria-labelledby={`${ids}-hours`}
              value={hours}
              onValueChange={(value) => setHours(value as SupportHours)}
              className="flex flex-wrap gap-2"
            >
              {SUPPORT_HOURS.map((option) => (
                <label
                  key={option}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line px-3 text-base text-ink has-data-checked:border-2 has-data-checked:border-ring"
                >
                  <RadioGroupItem value={option} />
                  {option === 1 ? '1 hour' : `${option} hours`}
                </label>
              ))}
            </RadioGroup>
          </fieldset>
          <Button size="touch" onClick={allow} disabled={pending}>
            {pending ? 'Allowing…' : 'Allow access'}
          </Button>
        </div>
      )}

      {history.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 id={`${ids}-changes`} className="text-sm font-semibold text-ink">
            Changes made by MenuMesh support
          </h3>
          {truncated && (
            <p className="text-sm text-ink-muted">The latest 1,000 changes are shown.</p>
          )}
          <ul aria-labelledby={`${ids}-changes`} className="flex flex-col gap-3">
            {history.map((session) => (
              <li key={session.id} className="flex flex-col gap-1 text-sm">
                <p className="font-medium text-ink">
                  {session.staffName}, {formatBillDate(session.startedAt, timezone)}
                  {session.consent === 'onboarding' && ' (while setting up the restaurant)'}
                </p>
                {session.changes.length ? (
                  <ul className="list-disc pl-5 text-ink">
                    {session.changes.map((change, index) => (
                      <li key={index}>{change}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ink-muted">No changes.</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
