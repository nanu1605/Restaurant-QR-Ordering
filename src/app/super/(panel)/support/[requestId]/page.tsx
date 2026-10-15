import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { Breadcrumbs } from '@/features/platform/components/breadcrumbs';
import { Facts, Section } from '@/features/platform/components/restaurant-sections';
import { formatMobile, telHref, whatsappHref } from '@/features/platform/dues-messages';
import { formatDateTime } from '@/features/platform/platform';
import { getTeam } from '@/features/platform/queries';
import { NoteForm, RequestControls } from '@/features/support/components/request-controls';
import { addSupportNote } from '@/features/support/inbox-actions';
import { PriorityBadge, SupportStatusBadge } from '@/features/support/components/support-badges';
import { getSupportRequest } from '@/features/support/inbox-queries';
import {
  CONTACT_METHOD_LABELS,
  eventLine,
  SUPPORT_TOPIC_LABELS,
  type SupportRequest,
} from '@/features/support/support';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { ROLE_LABELS, type MemberRole } from '@/lib/auth/roles';

const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';

export async function generateMetadata({ params }: PageProps<'/super/support/[requestId]'>) {
  await requirePlatformPermission('restaurants.support');
  const found = await getSupportRequest((await params).requestId);
  return {
    title: found
      ? `${SUPPORT_TOPIC_LABELS[found.request.topic]}, ${found.request.restaurant_name}`
      : 'Support request',
  };
}

/**
 * One support request (docs/DECISIONS.md SA-43): what was asked, by whom and
 * from where, its screenshot, and the team's status, priority, assignee and
 * internal notes.
 */
export default async function SupportRequestPage({
  params,
}: PageProps<'/super/support/[requestId]'>) {
  await requirePlatformPermission('restaurants.support');
  const { requestId } = await params;
  const [found, team] = await Promise.all([
    getSupportRequest(requestId),
    getTeam('restaurants.support'),
  ]);
  if (!found) notFound();
  const { request, screenshotUrl } = found;

  return (
    <>
      <Breadcrumbs items={[{ href: '/super/support', label: 'Support inbox' }]} />
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold [overflow-wrap:anywhere] text-ink">
          {SUPPORT_TOPIC_LABELS[request.topic]}: {request.restaurant_name}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <SupportStatusBadge status={request.status} />
          <PriorityBadge priority={request.priority} />
          <span className="text-sm text-ink-muted">
            Sent {formatDateTime(request.created_at)}
            {request.resolved_at && `, resolved ${formatDateTime(request.resolved_at)}`}
          </span>
        </div>
        <RequestControls
          requestId={request.id}
          status={request.status}
          priority={request.priority}
          assigneeId={request.assignee_id}
          team={team}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title="Message">
            <p className="text-sm [overflow-wrap:anywhere] whitespace-pre-line text-ink">
              {request.message}
            </p>
            {request.screenshot_path &&
              (screenshotUrl ? (
                <a href={screenshotUrl} target="_blank" rel="noopener noreferrer" className="w-fit">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a signed link to a private file */}
                  <img
                    src={screenshotUrl}
                    alt="The screenshot sent with the request (opens full size)"
                    className="max-h-96 max-w-full rounded-md border border-line object-contain"
                  />
                </a>
              ) : (
                <p className="text-sm text-ink-muted">The screenshot could not be loaded.</p>
              ))}
          </Section>

          <Section title="Notes and history">
            <ol className="flex flex-col gap-3 text-sm">
              <li className="text-ink-muted">
                {formatDateTime(request.created_at)}: sent by {request.created_by_name}
              </li>
              {request.events.map((event) =>
                event.kind === 'note' ? (
                  <li key={event.id} className="rounded-md border border-line p-3">
                    <p className="text-xs text-ink-muted">
                      Internal note, {event.actor ?? 'a former team member'},{' '}
                      {formatDateTime(event.at)}
                    </p>
                    <p className="[overflow-wrap:anywhere] whitespace-pre-line text-ink">
                      {event.body}
                    </p>
                  </li>
                ) : (
                  <li key={event.id} className="text-ink-muted">
                    {formatDateTime(event.at)}: {eventLine(event)}
                    {event.actor && `, by ${event.actor}`}
                  </li>
                ),
              )}
            </ol>
            <NoteForm save={addSupportNote.bind(null, request.id)} />
          </Section>
        </div>

        <Section title="From">
          <Facts
            facts={[
              [
                'Restaurant',
                <Link
                  key="r"
                  href={`/super/restaurants/${request.restaurant_id}`}
                  className={linkClass}
                >
                  {request.restaurant_name}
                </Link>,
              ],
              ['Code', request.slug],
              ['City', request.city ?? '—'],
              [
                'Asked by',
                `${request.created_by_name}, ${ROLE_LABELS[request.created_by_role as MemberRole] ?? request.created_by_role}`,
              ],
              ['Login', request.created_by_email ?? '—'],
              ['Reach them', <Contact key="c" request={request} />],
              ['Page', request.context.page ?? '—'],
              ['App version', request.context.app_version ?? 'Not known'],
              ['Browser', request.context.browser ?? 'Not known'],
            ]}
          />
        </Section>
      </div>
    </>
  );
}

/** How they asked to be reached, as a link that does it. */
function Contact({ request }: { request: SupportRequest }): ReactNode {
  const method = CONTACT_METHOD_LABELS[request.contact_method];
  if (request.contact_method === 'email') {
    return (
      <span>
        {method}:{' '}
        <a href={`mailto:${request.contact}`} className={linkClass}>
          {request.contact}
        </a>
      </span>
    );
  }
  const href =
    request.contact_method === 'call'
      ? telHref(request.contact)
      : whatsappHref(request.contact, '');
  const shown = formatMobile(request.contact) ?? request.contact;
  return (
    <span>
      {method}:{' '}
      {href ? (
        <a
          href={href}
          className={linkClass}
          {...(request.contact_method === 'whatsapp'
            ? { target: '_blank', rel: 'noopener noreferrer' }
            : {})}
        >
          {shown}
        </a>
      ) : (
        shown
      )}
    </span>
  );
}
