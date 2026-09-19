import 'server-only';

import { cache } from 'react';

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
  restaurant: {
    id: string;
    name: string;
    slug: string;
    status: Enums<'restaurant_status'>;
    timezone: string;
  };
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
 */
export const getCurrentMembership = cache(async (): Promise<CurrentMembership | null> => {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('restaurant_members')
    .select(
      'id, role, display_name, username, restaurant:restaurants!inner (id, name, slug, status, timezone)',
    )
    .eq('user_id', user.id)
    .eq('is_active', true)
    .order('created_at')
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Could not load membership: ${error.message}`);
  if (!data) return null;

  return {
    memberId: data.id,
    role: data.role,
    displayName: data.display_name,
    username: data.username,
    restaurant: data.restaurant,
  };
});

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
