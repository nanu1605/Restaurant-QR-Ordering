'use client';

import { usePathname, useRouter } from 'next/navigation';
import type { FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { hrefWithParams } from '@/lib/date-range';

import type { AuditFilters } from '../params';
import { ACTOR_TYPE_LABELS, ACTOR_TYPES } from '../platform';

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** Common action prefixes, offered as suggestions (any prefix works). */
const ACTION_SUGGESTIONS = [
  'restaurant.',
  'subscription.',
  'plan.updated',
  'offer.',
  'announcement.',
  'standee.',
  'platform_settings.updated',
  'support.viewed',
  'webhook.reprocessed',
  'staff.',
  'bill.',
  'discount.applied',
  'order.',
  'order_item.',
  'settings.',
];

/** Platform audit log filters (spec §13.4); everything lives in the URL. */
export function AuditFiltersForm({ filters }: { filters: AuditFilters }) {
  const router = useRouter();
  const pathname = usePathname();

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };
    router.push(
      hrefWithParams(pathname, {
        restaurant: filters.restaurant_id,
        member: filters.actor,
        actor: text('actor'),
        action: text('action'),
        from: text('from'),
        to: text('to'),
      }),
    );
  }

  return (
    <form
      key={JSON.stringify(filters)}
      onSubmit={apply}
      role="search"
      aria-label="Audit log"
      className="grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-5"
    >
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        Who
        <select name="actor" defaultValue={filters.actor_type ?? ''} className={SELECT_CLASS}>
          <option value="">Anyone</option>
          {ACTOR_TYPES.map((type) => (
            <option key={type} value={type}>
              {ACTOR_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        Action starts with
        <Input
          name="action"
          list="audit-actions"
          defaultValue={filters.action}
          placeholder="e.g. restaurant."
          autoCapitalize="none"
          spellCheck={false}
          className="h-11"
        />
        <datalist id="audit-actions">
          {ACTION_SUGGESTIONS.map((action) => (
            <option key={action} value={action} />
          ))}
        </datalist>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        From
        <Input type="date" name="from" defaultValue={filters.from} className="h-11" />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        To
        <Input type="date" name="to" defaultValue={filters.to} className="h-11" />
      </label>
      <div className="flex items-end gap-2">
        <Button type="submit" size="touch">
          Apply
        </Button>
        <Button
          type="button"
          size="touch"
          variant="ghost"
          onClick={() =>
            router.push(hrefWithParams(pathname, { restaurant: filters.restaurant_id }))
          }
        >
          Clear
        </Button>
      </div>
    </form>
  );
}
