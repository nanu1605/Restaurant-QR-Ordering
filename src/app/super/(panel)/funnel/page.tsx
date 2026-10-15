import type { Metadata } from 'next';
import Form from 'next/form';
import Link from 'next/link';

import { Money } from '@/components/shared/money';
import { PageHeader } from '@/components/shared/page-header';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  formatShare,
  sourceLabel,
  type Funnel,
  type UpgradeOpportunities,
} from '@/features/growth/funnel';
import { getFunnel, getUpgradeOpportunities } from '@/features/growth/queries';
import { Section } from '@/features/platform/components/restaurant-sections';
import { SubscriptionStateBadge } from '@/features/platform/components/status-badges';
import { formatMobile, telHref, whatsappHref } from '@/features/platform/dues-messages';
import { ACQUISITION_CHANNEL_LABELS, formatDate, todayInIndia } from '@/features/platform/platform';
import { limitHitLabel } from '@/features/platform/restaurant-page';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { addDays, hrefWithParams, platformPresets, readDateRange } from '@/lib/date-range';

export const metadata: Metadata = {
  title: 'Funnel',
};

const PATH = '/super/funnel';
const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';
const n = (value: number) => value.toLocaleString('en-IN');

/**
 * Where restaurants come from and how far they get (docs/SUPER_ADMIN_PLAN.md
 * 13d and §5.14, docs/DECISIONS.md SA-58 to SA-60), for India dates; and the
 * Starter restaurants ready for a bigger plan.
 */
export default async function FunnelPage({ searchParams }: PageProps<'/super/funnel'>) {
  await requirePlatformPermission('growth.manage');
  const today = todayInIndia();
  const { range, notice } = readDateRange(await searchParams, 'The funnel');
  const from = range.from ?? addDays(today, -29);
  const to = range.to ?? (range.from ? range.from : today);
  const [funnel, upgrades] = await Promise.all([getFunnel(from, to), getUpgradeOpportunities()]);

  return (
    <>
      <PageHeader
        title="Funnel"
        description="Where restaurants come from and how far they get. Dates are India time."
      />
      <nav aria-label="Period" className="flex flex-wrap gap-2">
        {platformPresets(today).map((preset) => {
          const active = from === preset.from && to === preset.to;
          return (
            <Link
              key={preset.key}
              href={hrefWithParams(PATH, { from: preset.from, to: preset.to })}
              aria-current={active ? 'page' : undefined}
              className={buttonVariants({ variant: active ? 'default' : 'outline', size: 'sm' })}
            >
              {preset.label}
            </Link>
          );
        })}
      </nav>
      <Form
        key={`${from}-${to}`}
        action={PATH}
        role="search"
        aria-label="Dates"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-3"
      >
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          From
          <Input type="date" name="from" defaultValue={from} className="h-11 md:h-9" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          To
          <Input type="date" name="to" defaultValue={to} className="h-11 md:h-9" />
        </label>
        <Button type="submit" size="touch">
          Show
        </Button>
      </Form>
      {notice && (
        <p role="status" className="text-sm text-ink">
          {notice}
        </p>
      )}

      <Steps funnel={funnel} />
      <Cohort funnel={funnel} />
      <Channels funnel={funnel} />
      <Sources funnel={funnel} />
      <Upgrades upgrades={upgrades} />
    </>
  );
}

/** The steps, each against the one before it (plan §5.14). */
function Steps({ funnel }: { funnel: Funnel }) {
  const signup = funnel.cohort.find((row) => row.kind === 'signup')!;
  const team = funnel.cohort.find((row) => row.kind === 'team')!;
  const created = signup.created + team.created;
  const firstOrder = signup.first_order + team.first_order;
  const firstPayment = signup.first_payment + team.first_payment;
  const started = funnel.signups_started;
  const steps: { label: string; value: number | null; share: string | null; note?: string }[] = [
    { label: 'Demo requests on the website', value: funnel.demo_requests, share: null },
    {
      label: 'Signups started',
      value: started,
      share: null,
      note:
        started === null
          ? 'Not counted for these dates: counts start with the nightly snapshots.'
          : funnel.signups_counted_from
            ? `Counted from ${formatDate(funnel.signups_counted_from)}, when the nightly snapshots began.`
            : undefined,
    },
    {
      label: 'Restaurants created by signup',
      value: signup.created,
      share: started === null ? null : `${formatShare(signup.created, started)} signups started`,
      note: 'Entering the emailed code creates the restaurant at once, so verified and created are one step.',
    },
    { label: 'Restaurants onboarded by the team', value: team.created, share: null },
    {
      label: 'First order',
      value: firstOrder,
      share: `${formatShare(firstOrder, created)} restaurants created`,
    },
    {
      label: 'First payment',
      value: firstPayment,
      share: `${formatShare(firstPayment, created)} restaurants created`,
    },
  ];
  const widest = Math.max(1, ...steps.map((step) => step.value ?? 0));

  return (
    <Section title="Steps">
      <p className="text-sm text-ink-muted">
        First order and first payment follow the restaurants created in these dates, up to today.
      </p>
      <ol className="flex flex-col gap-3">
        {steps.map((step) => (
          <li key={step.label} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-sm font-medium text-ink">{step.label}</span>
              <span className="text-lg font-semibold text-ink tabular-nums">
                {step.value === null ? '—' : n(step.value)}
              </span>
            </div>
            <div aria-hidden className="h-2 rounded-full bg-line">
              <div
                className="h-2 rounded-full bg-chart-1"
                style={{ width: `${((step.value ?? 0) / widest) * 100}%` }}
              />
            </div>
            {step.share && <p className="text-sm text-ink-muted tabular-nums">{step.share}</p>}
            {step.note && <p className="text-xs text-ink-muted">{step.note}</p>}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Cohort({ funnel }: { funnel: Funnel }) {
  const rows = [
    ...funnel.cohort.map((row) => ({
      label: row.kind === 'signup' ? 'Signed up on the website' : 'Onboarded by the team',
      ...row,
    })),
  ];
  const all = rows.reduce(
    (sum, row) => ({
      created: sum.created + row.created,
      first_order: sum.first_order + row.first_order,
      first_payment: sum.first_payment + row.first_payment,
    }),
    { created: 0, first_order: 0, first_payment: 0 },
  );
  return (
    <Section title="Restaurants created">
      <Table label="Restaurants created">
        <TableHeader>
          <TableRow>
            <TableHead>How</TableHead>
            <TableHead className="text-right">Created</TableHead>
            <TableHead>First order</TableHead>
            <TableHead>First payment</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.kind}>
              <TableCell>{row.label}</TableCell>
              <TableCell className="text-right tabular-nums">{n(row.created)}</TableCell>
              <TableCell className="tabular-nums">
                {formatShare(row.first_order, row.created)}
              </TableCell>
              <TableCell className="tabular-nums">
                {formatShare(row.first_payment, row.created)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>All</TableCell>
            <TableCell className="text-right tabular-nums">{n(all.created)}</TableCell>
            <TableCell className="tabular-nums">
              {formatShare(all.first_order, all.created)}
            </TableCell>
            <TableCell className="tabular-nums">
              {formatShare(all.first_payment, all.created)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </Section>
  );
}

/** By how they found MenuMesh; the totals match the restaurants created. */
function Channels({ funnel }: { funnel: Funnel }) {
  const rows = funnel.channels.filter((row) => row.leads + row.restaurants > 0);
  const total = funnel.channels.reduce(
    (sum, row) => ({
      leads: sum.leads + row.leads,
      restaurants: sum.restaurants + row.restaurants,
      paying: sum.paying + row.paying,
      mrr: sum.mrr + row.mrr_paise,
    }),
    { leads: 0, restaurants: 0, paying: 0, mrr: 0 },
  );
  return (
    <Section title="By channel">
      <p className="text-sm text-ink-muted">
        Leads that came in and restaurants created in these dates, by how they found MenuMesh.
        Paying and MRR are as of now, before GST.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No leads or restaurants in these dates.</p>
      ) : (
        <Table label="By channel">
          <TableHeader>
            <TableRow>
              <TableHead>Channel</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead className="text-right">Restaurants</TableHead>
              <TableHead>Paying now</TableHead>
              <TableHead className="text-right">MRR</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.channel}>
                <TableCell>
                  {row.channel === 'unknown'
                    ? 'Not known'
                    : ACQUISITION_CHANNEL_LABELS[row.channel]}
                </TableCell>
                <TableCell className="text-right tabular-nums">{n(row.leads)}</TableCell>
                <TableCell className="text-right tabular-nums">{n(row.restaurants)}</TableCell>
                <TableCell className="tabular-nums">
                  {formatShare(row.paying, row.restaurants)}
                </TableCell>
                <TableCell className="text-right">
                  <Money paise={row.mrr_paise} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>All</TableCell>
              <TableCell className="text-right tabular-nums">{n(total.leads)}</TableCell>
              <TableCell className="text-right tabular-nums">{n(total.restaurants)}</TableCell>
              <TableCell className="tabular-nums">
                {formatShare(total.paying, total.restaurants)}
              </TableCell>
              <TableCell className="text-right">
                <Money paise={total.mrr} />
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      )}
    </Section>
  );
}

/** Website demo requests and signups by utm source, else the site that linked. */
function Sources({ funnel }: { funnel: Funnel }) {
  const other = funnel.other_sources;
  return (
    <Section title="Website arrivals">
      {funnel.sources.length === 0 ? (
        <p className="text-sm text-ink-muted">No demo requests or signups in these dates.</p>
      ) : (
        <Table label="Website arrivals">
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Demo requests</TableHead>
              <TableHead className="text-right">Signups</TableHead>
              <TableHead className="text-right">Paying now</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {funnel.sources.map((row) => (
              <TableRow key={`${row.utm_source}|${row.referrer}`}>
                <TableCell className="max-w-72 break-words whitespace-normal">
                  {sourceLabel(row)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{n(row.demo_requests)}</TableCell>
                <TableCell className="text-right tabular-nums">{n(row.signups)}</TableCell>
                <TableCell className="text-right tabular-nums">{n(row.paying)}</TableCell>
              </TableRow>
            ))}
            {other && (
              <TableRow>
                <TableCell>{n(other.count)} other sources</TableCell>
                <TableCell className="text-right tabular-nums">{n(other.demo_requests)}</TableCell>
                <TableCell className="text-right tabular-nums">{n(other.signups)}</TableCell>
                <TableCell className="text-right tabular-nums">{n(other.paying)}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

/** Starter restaurants that hit a limit, are at one, or are busy (SA-60). */
function Upgrades({ upgrades }: { upgrades: UpgradeOpportunities }) {
  return (
    <Section title="Upgrade opportunities">
      <p className="text-sm text-ink-muted">
        Starter restaurants, now, that hit a plan limit in the last 30 days, are at their table or
        staff limit, or took {n(upgrades.busy_orders)} or more orders in the last 30 days.
      </p>
      {upgrades.rows.length === 0 ? (
        <p className="text-sm text-ink-muted">None right now.</p>
      ) : (
        <Table label="Upgrade opportunities">
          <TableHeader>
            <TableRow>
              <TableHead>Restaurant</TableHead>
              <TableHead>Why</TableHead>
              <TableHead className="text-right">Orders, 30 days</TableHead>
              <TableHead>Reach them</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {upgrades.rows.map((row) => {
              const tel = telHref(row.phone);
              const whatsapp = whatsappHref(row.phone, '');
              return (
                <TableRow key={row.restaurant_id}>
                  <TableCell className="max-w-64 whitespace-normal">
                    <Link href={`/super/restaurants/${row.restaurant_id}`} className={linkClass}>
                      {row.name}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <SubscriptionStateBadge state={row.state} />
                      {row.city && <span className="text-sm text-ink-muted">{row.city}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-80 whitespace-normal">
                    <ul className="flex flex-col text-sm">
                      {row.max_tables !== null && row.tables >= row.max_tables && (
                        <li>
                          At the table limit: {n(row.tables)} of {n(row.max_tables)}
                        </li>
                      )}
                      {row.max_staff !== null && row.staff >= row.max_staff && (
                        <li>
                          At the staff limit: {n(row.staff)} of {n(row.max_staff)}
                        </li>
                      )}
                      {row.hits.map((hit) => (
                        <li key={`${hit.kind}-${hit.feature}`}>
                          {limitHitLabel(hit)} ({hit.count === 1 ? 'once' : `${n(hit.count)} times`}
                          )
                        </li>
                      ))}
                      {row.orders >= upgrades.busy_orders && <li>Busy</li>}
                    </ul>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{n(row.orders)}</TableCell>
                  <TableCell>
                    {tel ? (
                      <div className="flex flex-col gap-1 text-sm">
                        <a href={tel} className={linkClass}>
                          Call {formatMobile(row.phone)}
                        </a>
                        {whatsapp && (
                          <a
                            href={whatsapp}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={linkClass}
                          >
                            WhatsApp
                          </a>
                        )}
                      </div>
                    ) : (
                      <span className="text-sm text-ink-muted">
                        {row.phone ?? 'No mobile number'}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
