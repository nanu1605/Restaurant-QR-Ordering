import 'server-only';

import { createClient } from '@/lib/supabase/server';

import { supportChangeLine, untilText } from './support-access';

/** A restaurant's support window, open now (docs/DECISIONS.md SA-47). */
export type SupportWindow = {
  id: string;
  endsAt: string;
  /** Null until a team member starts working in it. */
  userId: string | null;
  staffName: string | null;
};

export type SupportSessionHistory = {
  id: string;
  consent: 'owner' | 'onboarding';
  startedAt: string;
  staffName: string;
  changes: string[];
};

const COLUMNS = 'id, consent, created_at, ends_at, started_at, ended_at, user_id, staff_name';
// The changes of the last 10 sessions, newest kept when there are more.
const CHANGES_LIMIT = 1000;

/**
 * The owner's card: the open window (with when it ends, worked out here so the
 * page and the browser agree), and the last 10 sessions with every change made
 * in each (RLS: the restaurant's owner).
 */
export async function getSupportAccess(restaurantId: string, timezone: string) {
  const supabase = await createClient();
  const [openResult, usedResult] = await Promise.all([
    supabase
      .from('support_sessions')
      .select(COLUMNS)
      .eq('restaurant_id', restaurantId)
      .is('ended_at', null)
      .gt('ends_at', new Date().toISOString())
      .maybeSingle(),
    supabase
      .from('support_sessions')
      .select(COLUMNS)
      .eq('restaurant_id', restaurantId)
      .not('started_at', 'is', null)
      .order('started_at', { ascending: false })
      .limit(10),
  ]);
  if (openResult.error)
    throw new Error(`Could not load support access: ${openResult.error.message}`);
  if (usedResult.error)
    throw new Error(`Could not load support sessions: ${usedResult.error.message}`);
  const open = openResult.data;
  const used = usedResult.data;

  const changes = used.length
    ? await supabase
        .from('audit_logs')
        .select('action, entity_id, after, support_session_id')
        .eq('restaurant_id', restaurantId)
        .in(
          'support_session_id',
          used.map((row) => row.id),
        )
        .order('created_at', { ascending: false })
        .limit(CHANGES_LIMIT)
    : { data: [], error: null };
  if (changes.error) throw new Error(`Could not load support changes: ${changes.error.message}`);
  const rows = [...changes.data].reverse();

  // Logins are named by username, so the owner can change their passwords.
  const loginIds = rows
    .filter((row) => row.action.startsWith('staff.') && row.entity_id)
    .map((row) => row.entity_id!);
  const logins: Record<string, string> = {};
  if (loginIds.length) {
    const { data: members, error: membersError } = await supabase
      .from('restaurant_members')
      .select('id, username')
      .in('id', loginIds);
    if (membersError) throw new Error(`Could not load logins: ${membersError.message}`);
    for (const member of members) logins[member.id] = member.username;
  }

  const history: SupportSessionHistory[] = used.map((row) => ({
    id: row.id,
    consent: row.consent === 'onboarding' ? 'onboarding' : 'owner',
    startedAt: row.started_at!,
    staffName: row.staff_name ?? 'MenuMesh support',
    changes: rows
      .filter((change) => change.support_session_id === row.id)
      .map((change) =>
        supportChangeLine(
          {
            action: change.action,
            entity_id: change.entity_id,
            after: change.after as Record<string, unknown> | null,
          },
          logins,
        ),
      ),
  }));

  return {
    open: open
      ? {
          id: open.id,
          endsAt: open.ends_at,
          until: untilText(open.ends_at, timezone),
          userId: open.user_id,
          staffName: open.started_at ? open.staff_name : null,
        }
      : null,
    history,
    /** Older changes were left out. */
    truncated: changes.data.length === CHANGES_LIMIT,
  } satisfies {
    open: (SupportWindow & { until: string }) | null;
    history: SupportSessionHistory[];
    truncated: boolean;
  };
}

/**
 * The open window on a restaurant's page in /super, and the name this team
 * member used last (RLS: platform admins at the second factor).
 */
export async function getSupportWindow(restaurantId: string, userId: string) {
  const supabase = await createClient();
  const [windowResult, lastResult] = await Promise.all([
    supabase
      .from('support_sessions')
      .select(COLUMNS)
      .eq('restaurant_id', restaurantId)
      .is('ended_at', null)
      .gt('ends_at', new Date().toISOString())
      .maybeSingle(),
    supabase
      .from('support_sessions')
      .select('staff_name')
      .eq('user_id', userId)
      .not('staff_name', 'is', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (windowResult.error) {
    throw new Error(`Could not load support access: ${windowResult.error.message}`);
  }
  if (lastResult.error) throw new Error(`Could not load your name: ${lastResult.error.message}`);
  const row = windowResult.data;
  return {
    window: row
      ? ({
          id: row.id,
          endsAt: row.ends_at,
          userId: row.user_id,
          staffName: row.started_at ? row.staff_name : null,
        } satisfies SupportWindow)
      : null,
    lastName: lastResult.data?.staff_name ?? '',
  };
}
