import Link from 'next/link';
import { notFound } from 'next/navigation';

import { describeSource } from '@/features/analytics/attribution';
import { addLeadNote } from '@/features/growth/actions';
import { LeadStageBadge, OverdueBadge } from '@/features/growth/components/lead-badges';
import {
  LeadContact,
  LeadControls,
  LeadTimeField,
  LinkRestaurant,
} from '@/features/growth/components/lead-controls';
import {
  followUpOverdue,
  LEAD_STAGE_LABELS,
  leadChannelLabel,
  leadEventLine,
} from '@/features/growth/leads';
import { getLead } from '@/features/growth/queries';
import { Breadcrumbs } from '@/features/platform/components/breadcrumbs';
import { Facts, Section } from '@/features/platform/components/restaurant-sections';
import { SubscriptionStateBadge } from '@/features/platform/components/status-badges';
import {
  formatDateTime,
  SUBSCRIPTION_STATES,
  type SubscriptionState,
} from '@/features/platform/platform';
import { getTeam } from '@/features/platform/queries';
import { NoteForm } from '@/features/support/components/request-controls';
import { requirePlatformPermission } from '@/lib/auth/guards';

const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';

export async function generateMetadata({ params }: PageProps<'/super/leads/[leadId]'>) {
  await requirePlatformPermission('growth.manage');
  const lead = await getLead((await params).leadId);
  return { title: lead ? `${lead.name}, ${lead.restaurant_name}` : 'Lead' };
}

/**
 * One lead (docs/DECISIONS.md SA-55): how to reach them, stage and assignee,
 * the next follow-up and the demo, the restaurant it became, others with the
 * same mobile, and its notes and history.
 */
export default async function LeadPage({ params }: PageProps<'/super/leads/[leadId]'>) {
  await requirePlatformPermission('growth.manage');
  const { leadId } = await params;
  const [lead, team] = await Promise.all([getLead(leadId), getTeam('growth.manage')]);
  if (!lead) notFound();
  const linkedState = SUBSCRIPTION_STATES.includes(lead.restaurant?.state as SubscriptionState)
    ? (lead.restaurant?.state as SubscriptionState)
    : null;
  const otherRestaurants = lead.matches.restaurants.filter((r) => r.id !== lead.restaurant?.id);

  return (
    <>
      <Breadcrumbs items={[{ href: '/super/leads', label: 'Leads' }]} />
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold [overflow-wrap:anywhere] text-ink">
          {lead.name}: {lead.restaurant_name}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <LeadStageBadge stage={lead.stage} lostReason={lead.lost_reason} />
          {followUpOverdue(lead) && <OverdueBadge />}
          <span className="text-sm text-ink-muted">
            {lead.city}. {leadChannelLabel(lead.channel)}, {formatDateTime(lead.created_at)}
            {lead.created_by && `, added by ${lead.created_by}`}
          </span>
        </div>
        <LeadControls
          leadId={lead.id}
          stage={lead.stage}
          lostReason={lead.lost_reason}
          assigneeId={lead.assignee_id}
          team={team}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Reach them">
            <LeadContact
              leadId={lead.id}
              phone={lead.phone}
              email={lead.email}
              stage={lead.stage}
            />
          </Section>

          <Section title="Next steps">
            <div className="flex flex-col gap-4">
              <LeadTimeField
                leadId={lead.id}
                field="follow_up_at"
                label="Follow-up"
                value={lead.follow_up_at}
              />
              <LeadTimeField leadId={lead.id} field="demo_at" label="Demo" value={lead.demo_at} />
            </div>
          </Section>

          <Section title="Notes and history">
            <ol className="flex flex-col gap-3 text-sm">
              <li className="text-ink-muted">
                {formatDateTime(lead.created_at)}:{' '}
                {lead.created_by ? `added by ${lead.created_by}` : 'sent from the website'}
              </li>
              {lead.message && (
                <li className="rounded-md border border-line p-3">
                  <p className="text-xs text-ink-muted">
                    {lead.created_by ? 'What they need' : 'Their message'}
                  </p>
                  <p className="[overflow-wrap:anywhere] whitespace-pre-line text-ink">
                    {lead.message}
                  </p>
                </li>
              )}
              {lead.events.map((event) =>
                event.kind === 'note' ? (
                  <li key={event.id} className="rounded-md border border-line p-3">
                    <p className="text-xs text-ink-muted">
                      Note, {event.actor ?? 'a former team member'}, {formatDateTime(event.at)}
                    </p>
                    <p className="[overflow-wrap:anywhere] whitespace-pre-line text-ink">
                      {event.body}
                    </p>
                  </li>
                ) : (
                  <li key={event.id} className="text-ink-muted">
                    {formatDateTime(event.at)}: {leadEventLine(event)}
                  </li>
                ),
              )}
            </ol>
            <NoteForm save={addLeadNote.bind(null, lead.id)} />
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Details">
            <Facts
              facts={[
                ['Name', lead.name],
                ['Restaurant', lead.restaurant_name],
                ['City', lead.city],
                ['Email', lead.email ?? '—'],
                ['Plan asked about', lead.plan_code ?? '—'],
                ['Came from', leadChannelLabel(lead.channel)],
                ...(lead.source
                  ? [['Source', describeSource(lead.source).join('. ') || '—'] as [string, string]]
                  : []),
                ['Demo', formatDateTime(lead.demo_at)],
              ]}
            />
          </Section>

          <Section title="Restaurant">
            {lead.restaurant ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Link href={`/super/restaurants/${lead.restaurant.id}`} className={linkClass}>
                  {lead.restaurant.name}
                </Link>
                <span className="text-ink-muted">({lead.restaurant.slug})</span>
                {linkedState && <SubscriptionStateBadge state={linkedState} />}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">
                Not linked. It links by itself when a restaurant signs up or is onboarded with this
                mobile.
              </p>
            )}
            <LinkRestaurant
              leadId={lead.id}
              linked={lead.restaurant}
              suggestions={otherRestaurants.map((r) => ({ slug: r.slug, name: r.name }))}
            />
          </Section>

          {(otherRestaurants.length > 0 || lead.matches.leads.length > 0) && (
            <Section title="Same mobile">
              <ul className="flex flex-col gap-2 text-sm">
                {otherRestaurants.map((restaurant) => (
                  <li key={restaurant.id}>
                    Restaurant{' '}
                    <Link href={`/super/restaurants/${restaurant.id}`} className={linkClass}>
                      {restaurant.name}
                    </Link>
                    {restaurant.city && `, ${restaurant.city}`}
                  </li>
                ))}
                {lead.matches.leads.map((other) => (
                  <li key={other.id}>
                    Lead{' '}
                    <Link href={`/super/leads/${other.id}`} className={linkClass}>
                      {other.name}, {other.restaurant_name}
                    </Link>{' '}
                    ({LEAD_STAGE_LABELS[other.stage]}, {formatDateTime(other.created_at)})
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}
