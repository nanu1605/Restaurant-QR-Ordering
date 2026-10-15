import 'server-only';

import { cache } from 'react';

import type { Lang } from '@/features/ordering/strings';
import { platformAccessSchema, type PlatformAccess } from '@/features/platform/team';
import { createClient } from '@/lib/supabase/server';
import type { Enums } from '@/types/database';

import type { AccessSummary } from './redirects';
import type { MemberRole } from './roles';

export type CurrentUser = {
  id: string;
  email: string | null;
};

export type CurrentMembership = {
  memberId: string;
  role: MemberRole;
  displayName: string;
  username: string;
  /** The worker panel's language for this login (docs/DECISIONS.md P11-15). */
  uiLang: Lang;
  restaurant: {
    id: string;
    name: string;
    slug: string;
    status: Enums<'restaurant_status'>;
    timezone: string;
  };
  /** A MenuMesh team member in a support session (docs/DECISIONS.md SA-46). */
  support: { sessionId: string; endsAt: string } | null;
};

/**
 * The signed-in user, verified with getClaims() (JWT checked, not just read
 * from the cookie). Deduplicated per request with React cache().
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  const email = typeof data.claims.email === 'string' ? data.claims.email : null;
  return { id: data.claims.sub, email };
});

/**
 * The user's active membership. MVP: an account belongs to one restaurant
 * (spec §3); the schema allows more, so take the oldest if that ever changes.
 * Without one, a team member's support session acts as a manager membership
 * until it ends; the database checks the same on every call (SA-46, SA-48).
 */
export const getCurrentMembership = cache(async (): Promise<CurrentMembership | null> => {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('restaurant_members')
    .select(
      'id, role, display_name, username, ui_lang, restaurant:restaurants!inner (id, name, slug, status, timezone)',
    )
    .eq('user_id', user.id)
    .eq('is_active', true)
    .order('created_at')
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Could not load membership: ${error.message}`);
  if (!data) return getSupportMembership(user.id);

  return {
    memberId: data.id,
    role: data.role,
    displayName: data.display_name,
    username: data.username,
    uiLang: data.ui_lang === 'hi' ? 'hi' : 'en',
    restaurant: data.restaurant,
    support: null,
  };
});

/** Only a platform admin at the second factor reads sessions (RLS). */
async function getSupportMembership(userId: string): Promise<CurrentMembership | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('support_sessions')
    .select(
      'id, staff_name, ends_at, restaurant:restaurants!inner (id, name, slug, status, timezone)',
    )
    .eq('user_id', userId)
    .is('ended_at', null)
    .not('started_at', 'is', null)
    .gt('ends_at', new Date().toISOString())
    .maybeSingle();
  if (error) throw new Error(`Could not load the support session: ${error.message}`);
  if (!data) return null;

  return {
    memberId: data.id,
    role: 'manager',
    displayName: data.staff_name ?? 'MenuMesh support',
    username: 'menumesh_support',
    uiLang: 'en',
    restaurant: data.restaurant,
    support: { sessionId: data.id, endsAt: data.ends_at },
  };
}

export type PlatformAdminStatus = 'none' | 'mfa_required' | 'ok';

/**
 * Whether the user is a platform admin, and whether this session has passed
 * the second factor (docs/DECISIONS.md P7-1). Only 'ok' can read platform data.
 */
export const getPlatformAdminStatus = cache(async (): Promise<PlatformAdminStatus> => {
  const user = await getCurrentUser();
  if (!user) return 'none';
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_admin_status');
  if (error) throw new Error(`Could not check platform admin: ${error.message}`);
  return data === 'ok' || data === 'mfa_required' ? data : 'none';
});

/**
 * The signed-in team member's role, name and permissions (docs/DECISIONS.md
 * SA-70), as the database gives them; null for anyone else.
 */
export const getPlatformAccess = cache(async (): Promise<PlatformAccess | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_my_access');
  if (error) throw new Error(`Could not read the team member's access: ${error.message}`);
  return platformAccessSchema.parse(data);
});

/** A platform admin, with or without the second factor yet (routing only). */
export const getIsPlatformAdmin = cache(
  async (): Promise<boolean> => (await getPlatformAdminStatus()) !== 'none',
);

export async function getAccessSummary(): Promise<AccessSummary> {
  const [isPlatformAdmin, membership] = await Promise.all([
    getIsPlatformAdmin(),
    getCurrentMembership(),
  ]);
  return { isPlatformAdmin, role: membership?.role ?? null };
}
