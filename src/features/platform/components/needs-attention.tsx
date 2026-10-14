import { CheckCircle2, Phone } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Money } from '@/components/shared/money';
import { buttonVariants } from '@/components/ui/button';

import { ONBOARDING_STEP_LABELS } from '@/features/onboarding/onboarding';
import { SUPPORT_STATUS_LABELS, SUPPORT_TOPIC_LABELS } from '@/features/support/support';

import { duesMessage, formatMobile, telHref } from '../dues-messages';
import { attentionGroupLabel, type Attention, type AttentionGroupList } from '../home';
import {
  firstUnpaidDay,
  formatDateTime,
  formatShortDate,
  LOOKALIKE_REASON_LABELS,
  ONBOARDING_VIEW_COLUMNS,
  periodLastDay,
  type DuesRow,
} from '../platform';
import { DuesContact } from './dues-contact';
import { DuesActions, type LinkDefaults } from './restaurant-actions';
import { SnoozeMenu } from './snooze-menu';

// Where each group's full list lives.
const SEE_ALL: Partial<Record<AttentionGroupList['group'], string>> = {
  payment_failed: '/super/money/dues?bucket=payment_failed',
  trial_ending: '/super/money/dues?bucket=trial_ending',
  needs_payment: '/super/money/dues?bucket=renewal_due&days=7',
  new_leads: '/super/leads',
  support_open: '/super/support',
  stuck_onboarding: `/super/restaurants?onboarding=stuck&cols=${ONBOARDING_VIEW_COLUMNS}`,
  inactive: '/super/restaurants?health=inactive',
  slowing: '/super/restaurants?health=slowing',
  webhooks: '/super/webhooks?status=failed',
};

const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';
const actionClass = buttonVariants({ variant: 'outline', className: 'h-11 md:h-8' });

function RestaurantLink({ id, name }: { id: string; name: string }) {
  return (
    <Link href={`/super/restaurants/${id}`} className={linkClass}>
      {name}
    </Link>
  );
}

function Row({
  title,
  details,
  action,
  itemKey,
  label,
}: {
  title: ReactNode;
  details: ReactNode[];
  action: ReactNode;
  itemKey: string;
  label: string;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
      <div className="flex min-w-0 flex-1 basis-56 flex-col">
        {title}
        <p className="text-sm text-ink-muted">
          {details.filter(Boolean).map((detail, index) => (
            <span key={index}>
              {index > 0 && ' · '}
              {detail}
            </span>
          ))}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {action}
        <SnoozeMenu itemKey={itemKey} label={label} />
      </div>
    </li>
  );
}

function CallButton({ phone, name }: { phone: string | null; name: string }) {
  const tel = telHref(phone);
  if (!tel) return <span className="text-sm text-ink-muted">{phone ?? 'No mobile number'}</span>;
  return (
    <a href={tel} className={actionClass} aria-label={`Call ${name} on ${formatMobile(phone)}`}>
      <Phone aria-hidden />
      Call
    </a>
  );
}

function duesItem(
  group: 'payment_failed' | 'trial_ending' | 'needs_payment',
  key: string,
  row: DuesRow,
  linkDefaults: (row: DuesRow) => LinkDefaults | null,
) {
  const payment = (
    <DuesActions
      single
      restaurantId={row.restaurant_id}
      restaurantName={row.name}
      canExtendTrial={false}
      paymentStart={firstUnpaidDay({
        status: row.status,
        restrictionAt: row.restriction_at,
        currentPeriodEnd: row.current_period_end,
      })}
      linkDefaults={linkDefaults(row)}
    />
  );
  const due = (
    <>
      <Money paise={row.due_paise} fraction="auto" /> with GST
    </>
  );
  const title = <RestaurantLink id={row.restaurant_id} name={row.name} />;
  if (group === 'payment_failed') {
    const until = row.grace_until ?? row.current_period_end;
    return (
      <Row
        key={key}
        itemKey={key}
        label={row.name}
        title={title}
        details={[until && `Grace ends ${formatShortDate(until)}`, due]}
        action={payment}
      />
    );
  }
  if (group === 'trial_ending') {
    return (
      <Row
        key={key}
        itemKey={key}
        label={row.name}
        title={title}
        details={[
          row.trial_ends_at && `Trial ends ${formatShortDate(row.trial_ends_at)}`,
          row.plan_name,
        ]}
        action={
          <DuesContact
            restaurantName={row.name}
            phone={row.phone}
            messages={{
              en: duesMessage('trial_ending', row, 'en'),
              hi: duesMessage('trial_ending', row, 'hi'),
            }}
          />
        }
      />
    );
  }
  return (
    <Row
      key={key}
      itemKey={key}
      label={row.name}
      title={title}
      details={[
        row.current_period_end &&
          `Paid till ${formatShortDate(periodLastDay(row.current_period_end))}`,
        due,
      ]}
      action={payment}
    />
  );
}

function items(group: AttentionGroupList, linkDefaults: (row: DuesRow) => LinkDefaults | null) {
  switch (group.group) {
    case 'payment_failed':
    case 'trial_ending':
    case 'needs_payment':
      return group.items.map(({ key, data }) => duesItem(group.group, key, data, linkDefaults));
    case 'new_leads':
      return group.items.map(({ key, data }) => (
        <Row
          key={key}
          itemKey={key}
          label={data.name}
          title={<span className="font-medium text-ink">{data.name}</span>}
          details={[data.restaurant_name, data.city, formatDateTime(data.created_at)]}
          action={
            <Link href={`/super/leads?lead=${data.lead_id}`} className={actionClass}>
              Open
            </Link>
          }
        />
      ));
    case 'support_open':
      return group.items.map(({ key, data }) => (
        <Row
          key={key}
          itemKey={key}
          label={data.name}
          title={<RestaurantLink id={data.restaurant_id} name={data.name} />}
          details={[
            SUPPORT_TOPIC_LABELS[data.topic],
            SUPPORT_STATUS_LABELS[data.status],
            `Sent ${formatDateTime(data.created_at)}`,
          ]}
          action={
            <Link href={`/super/support/${data.request_id}`} className={actionClass}>
              Open
            </Link>
          }
        />
      ));
    case 'stuck_onboarding':
      return group.items.map(({ key, data }) => (
        <Row
          key={key}
          itemKey={key}
          label={data.name}
          title={<RestaurantLink id={data.restaurant_id} name={data.name} />}
          details={[
            `Next: ${ONBOARDING_STEP_LABELS[data.next]}`,
            `Nothing done since ${formatShortDate(data.since)}`,
            data.city,
          ]}
          action={<CallButton phone={data.phone} name={data.name} />}
        />
      ));
    case 'inactive':
    case 'slowing':
      return group.items.map(({ key, data }) => (
        <Row
          key={key}
          itemKey={key}
          label={data.name}
          title={<RestaurantLink id={data.restaurant_id} name={data.name} />}
          details={[data.city]}
          action={<CallButton phone={data.phone} name={data.name} />}
        />
      ));
    case 'duplicates':
      return group.items.map(({ key, data }) => {
        const match = data.matches[0];
        return (
          <Row
            key={key}
            itemKey={key}
            label={data.name}
            title={<RestaurantLink id={data.restaurant_id} name={data.name} />}
            details={[
              `Signed up ${formatDateTime(data.created_at)}`,
              match &&
                `Like ${match.name}: ${match.reasons.map((r) => LOOKALIKE_REASON_LABELS[r].toLowerCase()).join(', ')}`,
            ]}
            action={
              <Link href={`/super/restaurants/${data.restaurant_id}`} className={actionClass}>
                Review
              </Link>
            }
          />
        );
      });
    case 'webhooks':
      return group.items.map(({ key, data }) => (
        <Row
          key={key}
          itemKey={key}
          label={data.event_type}
          title={<span className="font-medium text-ink">{data.event_type}</span>}
          details={[formatDateTime(data.received_at), data.error]}
          action={
            <Link href="/super/webhooks?status=failed" className={actionClass}>
              Open
            </Link>
          }
        />
      ));
    case 'cron':
      return group.items.map(({ key, data }) => (
        <Row
          key={key}
          itemKey={key}
          label={`${data.job} ${data.step}`}
          title={
            <span className="font-medium text-ink">
              {data.job === 'daily' ? 'Nightly job' : data.job}: {data.step}
            </span>
          }
          details={[formatDateTime(data.started_at), data.detail]}
          action={null}
        />
      ));
  }
}

/**
 * Needs attention (docs/SUPER_ADMIN_PLAN.md 12e, docs/DECISIONS.md SA-28):
 * the one prominent list on Home, grouped, each item with one action and a
 * snooze. Items leave by themselves once resolved.
 */
export function NeedsAttention({
  attention,
  linkDefaults,
}: {
  attention: Attention;
  linkDefaults: (row: DuesRow) => LinkDefaults | null;
}) {
  return (
    <section aria-labelledby="attention-heading" className="flex flex-col gap-3">
      <h2
        id="attention-heading"
        tabIndex={-1}
        className="text-lg font-semibold text-ink outline-none"
      >
        Needs attention <span className="tabular-nums">({attention.total})</span>
      </h2>
      {attention.groups.length === 0 ? (
        <p className="flex items-center gap-2 rounded-lg border border-line bg-surface p-3 text-sm text-ink-muted">
          <CheckCircle2 aria-hidden className="size-4 text-status-served" />
          Nothing needs attention right now.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {attention.groups.map((group) => {
            const id = `attention-${group.group}`;
            const more = group.count - group.items.length;
            const seeAll = SEE_ALL[group.group];
            return (
              <section key={group.group} aria-labelledby={id} className="flex flex-col py-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 pt-2">
                  <h3 id={id} className="text-sm font-semibold text-ink">
                    {attentionGroupLabel(group.group, attention.inactive_days)}{' '}
                    <span className="tabular-nums">({group.count})</span>
                  </h3>
                  {seeAll && (
                    <Link
                      href={seeAll}
                      className="text-sm text-brand underline-offset-4 hover:underline"
                    >
                      {more > 0 ? `See all ${group.count}` : 'See the list'}
                    </Link>
                  )}
                </div>
                <ul className="flex flex-col">{items(group, linkDefaults)}</ul>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
