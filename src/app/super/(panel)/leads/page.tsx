import { Inbox, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Form from 'next/form';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Pager } from '@/components/shared/pager';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { describeSource } from '@/features/analytics/attribution';
import { LeadStageBadge } from '@/features/growth/components/lead-badges';
import { FollowUp, LeadCard, LeadLink } from '@/features/growth/components/lead-card';
import { LeadsSections } from '@/features/growth/components/leads-sections';
import {
  LEAD_CHANNELS,
  LEAD_DUE,
  LEAD_DUE_LABELS,
  LEAD_STAGE_LABELS,
  LEAD_TAB_LABELS,
  LEAD_TABS,
  leadChannelLabel,
  OPEN_STAGES,
  readLeadFilters,
  type LeadRow,
} from '@/features/growth/leads';
import { listLeads } from '@/features/growth/queries';
import { filterParams } from '@/features/platform/params';
import { formatDateTime } from '@/features/platform/platform';
import { getTeam } from '@/features/platform/queries';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { firstParam, hrefWithParams } from '@/lib/date-range';

export const metadata: Metadata = {
  title: 'Leads',
};

const PATH = '/super/leads';
const BOARD_LIMIT = 30;

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm';
const LABEL_CLASS = 'flex flex-col gap-1 text-sm font-medium text-ink';
const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';

/**
 * The leads pipeline (docs/SUPER_ADMIN_PLAN.md 13d, docs/DECISIONS.md SA-55):
 * demo requests from the website and leads the team added, by stage, as a
 * table or a board. Follow-ups due come first.
 */
export default async function SuperLeadsPage({ searchParams }: PageProps<'/super/leads'>) {
  await requirePlatformPermission('growth.manage');
  const params = await searchParams;
  // Links from before leads had pages (search results, alerts, emails).
  const old = firstParam(params, 'lead');
  if (old && /^[0-9a-f-]{36}$/i.test(old)) redirect(`${PATH}/${old}`);

  const filters = readLeadFilters(params);
  const board = filters.view === 'board';
  const [list, team] = await Promise.all([listLeads(filters), getTeam()]);
  const now = new Date();
  const tab = filters.stage ?? 'open';
  const withoutPage = { ...filters, page: undefined };
  const current = filterParams(withoutPage);
  // A page past the end, after leads moved on: the first page.
  if (!board && list.rows.length === 0 && filters.page > 1) redirect(hrefWithParams(PATH, current));
  const filtered = ['assignee', 'channel', 'due', 'q'].some((key) => key in current);

  return (
    <>
      <PageHeader
        title="Leads"
        description="Demo requests from the website and leads the team added. Times are India time."
        actions={
          <Link
            href={`${PATH}/new`}
            className={buttonVariants({ variant: 'default', size: 'touch' })}
          >
            <Plus aria-hidden />
            Add lead
          </Link>
        }
      />
      <LeadsSections current={PATH} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        {board ? (
          <p className="text-sm text-ink-muted">Leads in play, by stage.</p>
        ) : (
          <nav aria-label="Stage" className="flex flex-wrap gap-2">
            {LEAD_TABS.map((value) => (
              <Link
                key={value}
                href={hrefWithParams(
                  PATH,
                  filterParams({ ...withoutPage, stage: value === 'open' ? undefined : value }),
                )}
                aria-current={tab === value ? 'page' : undefined}
                className={buttonVariants({
                  variant: tab === value ? 'default' : 'outline',
                  size: 'sm',
                })}
              >
                {LEAD_TAB_LABELS[value]} ({list.counts[value].toLocaleString('en-IN')})
              </Link>
            ))}
          </nav>
        )}
        <nav aria-label="View" className="flex gap-2">
          {(['table', 'board'] as const).map((view) => {
            const active = (view === 'board') === board;
            return (
              <Link
                key={view}
                href={hrefWithParams(
                  PATH,
                  filterParams({
                    ...withoutPage,
                    stage: view === 'board' ? undefined : filters.stage,
                    view: view === 'board' ? 'board' : undefined,
                  }),
                )}
                aria-current={active ? 'page' : undefined}
                className={buttonVariants({ variant: active ? 'default' : 'outline', size: 'sm' })}
              >
                {view === 'board' ? 'Board' : 'Table'}
              </Link>
            );
          })}
        </nav>
      </div>

      <Form
        key={JSON.stringify(current)}
        action={PATH}
        role="search"
        aria-label="Leads"
        className="grid gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-5"
      >
        {filters.stage && !board && <input type="hidden" name="stage" value={filters.stage} />}
        {board && <input type="hidden" name="view" value="board" />}
        <label className={`${LABEL_CLASS} sm:col-span-2 lg:col-span-1`}>
          Search
          <Input
            type="search"
            name="q"
            defaultValue={filters.q}
            placeholder="Name, restaurant, city or mobile"
            className="h-11 md:h-9"
          />
        </label>
        <label className={LABEL_CLASS}>
          Assignee
          <select name="assignee" defaultValue={filters.assignee ?? ''} className={SELECT_CLASS}>
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="none">No one</option>
            {team.map((member) => (
              <option key={member.user_id} value={member.user_id}>
                {member.email}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          Came from
          <select name="channel" defaultValue={filters.channel ?? ''} className={SELECT_CLASS}>
            <option value="">Anywhere</option>
            {LEAD_CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {leadChannelLabel(channel)}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL_CLASS}>
          Follow-up
          <select name="due" defaultValue={filters.due ?? ''} className={SELECT_CLASS}>
            <option value="">Any time</option>
            {LEAD_DUE.map((due) => (
              <option key={due} value={due}>
                {LEAD_DUE_LABELS[due]}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <Button type="submit" size="touch">
            Apply
          </Button>
          <Link
            href={hrefWithParams(
              PATH,
              filterParams({ stage: board ? undefined : filters.stage, view: filters.view }),
            )}
            className={buttonVariants({ variant: 'ghost', size: 'touch' })}
          >
            Clear
          </Link>
        </div>
      </Form>

      {board ? (
        <Board rows={list.rows} counts={list.counts} now={now} withoutPage={withoutPage} />
      ) : list.rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={filtered ? 'No leads match' : 'No leads here'}
          description={
            filtered
              ? 'Try other filters, or clear them.'
              : 'Demo requests from the website’s contact page appear here, and leads you add.'
          }
        />
      ) : (
        <>
          <ul aria-label="Leads" className="flex flex-col gap-3 md:hidden">
            {list.rows.map((row) => (
              <LeadCard key={row.id} row={row} now={now} showStage />
            ))}
          </ul>
          <div className="hidden rounded-lg border border-line bg-surface md:block">
            <Table label="Leads">
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Follow-up</TableHead>
                  <TableHead>Assignee</TableHead>
                  <TableHead>Came from</TableHead>
                  <TableHead>Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.rows.map((row) => (
                  <TableRow key={row.id} data-lead-id={row.id}>
                    <TableCell className="max-w-80 min-w-56 whitespace-normal">
                      <LeadLink row={row} />
                      <p className="text-sm [overflow-wrap:anywhere] text-ink">
                        {row.restaurant_name}, {row.city}
                      </p>
                      {row.restaurant_id && (
                        <Link
                          href={`/super/restaurants/${row.restaurant_id}`}
                          className={linkClass}
                        >
                          <span className="text-sm">Restaurant: {row.restaurant}</span>
                        </Link>
                      )}
                    </TableCell>
                    <TableCell>
                      <LeadStageBadge stage={row.stage} lostReason={row.lost_reason} />
                    </TableCell>
                    <TableCell>
                      <FollowUp row={row} now={now} />
                    </TableCell>
                    <TableCell>{row.assignee ?? '—'}</TableCell>
                    <TableCell className="max-w-56 whitespace-normal">
                      <Source row={row} />
                    </TableCell>
                    <TableCell className="tabular-nums">{formatDateTime(row.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pager
            page={list.page ?? 1}
            pageSize={list.page_size ?? 50}
            total={list.total ?? 0}
            hrefFor={(page) => hrefWithParams(PATH, filterParams({ ...withoutPage, page }))}
          />
        </>
      )}
    </>
  );
}

/** The channel, and for a website lead where it came from. */
function Source({ row }: { row: LeadRow }) {
  return (
    <div className="flex flex-col text-sm">
      <span className="text-ink">{leadChannelLabel(row.channel)}</span>
      {describeSource(row.source).map((line) => (
        <span key={line} className="break-words text-ink-muted">
          {line}
        </span>
      ))}
    </div>
  );
}

/** The open stages side by side, up to 30 leads each. */
function Board({
  rows,
  counts,
  now,
  withoutPage,
}: {
  rows: LeadRow[];
  counts: Record<string, number>;
  now: Date;
  withoutPage: Record<string, string | number | undefined>;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      {OPEN_STAGES.map((stage) => {
        const items = rows.filter((row) => row.stage === stage);
        const count = counts[stage] ?? 0;
        return (
          <section
            key={stage}
            aria-labelledby={`board-${stage}`}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-paper p-2"
          >
            <h2 id={`board-${stage}`} className="px-1 text-sm font-semibold text-ink">
              {LEAD_STAGE_LABELS[stage]} ({count.toLocaleString('en-IN')})
            </h2>
            {items.length === 0 ? (
              <p className="px-1 text-sm text-ink-muted">None</p>
            ) : (
              <ul aria-label={LEAD_STAGE_LABELS[stage]} className="flex flex-col gap-2">
                {items.map((row) => (
                  <LeadCard key={row.id} row={row} now={now} showStage={false} />
                ))}
              </ul>
            )}
            {count > BOARD_LIMIT && (
              <Link
                href={hrefWithParams(
                  PATH,
                  filterParams({ ...withoutPage, view: undefined, stage }),
                )}
                className={`${linkClass} px-1 text-sm`}
              >
                All {count.toLocaleString('en-IN')}
              </Link>
            )}
          </section>
        );
      })}
    </div>
  );
}
