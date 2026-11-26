import { z } from 'zod';

import { hasNoHiddenCharacters } from '@/lib/person-name';

import { passwordSchema } from './schemas';

/**
 * The MenuMesh team (docs/SUPER_ADMIN_PLAN.md §3 and 13g, docs/DECISIONS.md
 * SA-70+). Which permissions a role holds lives in SQL
 * (private.role_permissions); the panel asks for the signed-in member's.
 */

export const TEAM_ROLES = ['admin', 'finance', 'sales', 'support'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  admin: 'Admin',
  finance: 'Finance',
  sales: 'Sales',
  support: 'Support',
};

/** What each role opens, in the words of the invite and role dialogs. */
export const TEAM_ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  admin: 'Everything, including the team and settings.',
  finance: 'Restaurants, money (payments, dues, revenue), recording payments and the audit log.',
  sales: 'Restaurants and changing them, leads and the funnel, and usage.',
  support: 'Restaurants, the support inbox and sessions, usage, and webhooks.',
};

/** Roles whose members may get the daily digest: it shows MRR and money collected. */
export const DIGEST_ROLES: readonly TeamRole[] = ['admin', 'finance'];

// ─── The signed-in member ─────────────────────────────────────────────────────
export const platformAccessSchema = z
  .object({
    status: z.enum(['ok', 'mfa_required']),
    role: z.enum(TEAM_ROLES),
    display_name: z.string().nullable(),
    permissions: z.array(z.string()),
  })
  .nullable();
export type PlatformAccess = NonNullable<z.infer<typeof platformAccessSchema>>;

// ─── The Team page ────────────────────────────────────────────────────────────
const memberSchema = z.object({
  user_id: z.string(),
  email: z.string().nullable(),
  display_name: z.string().nullable(),
  role: z.enum(TEAM_ROLES),
  invited_by: z.string().nullable(),
  invited_at: z.string().nullable(),
  joined_at: z.string().nullable(),
  disabled_at: z.string().nullable(),
  invite_expires_at: z.string().nullable(),
  second_factor: z.boolean(),
  last_sign_in_at: z.string().nullable(),
  digest: z.boolean(),
  is_you: z.boolean(),
});
export type TeamListRow = z.infer<typeof memberSchema>;
export const parseTeamList = (json: unknown) => z.array(memberSchema).parse(json);

/** Active, invited (not joined yet) or turned off. */
export function memberStatus(member: TeamListRow): 'active' | 'invited' | 'off' {
  if (member.disabled_at) return 'off';
  return member.joined_at ? 'active' : 'invited';
}

const displayName = z
  .string()
  .trim()
  .min(1, 'Enter their name.')
  .max(80, 'Keep the name under 80 characters.')
  .refine(hasNoHiddenCharacters, 'Remove the hidden characters from the name.');

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter an email address.')),
  displayName,
  role: z.enum(TEAM_ROLES, { message: 'Choose a role.' }),
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const memberPatchSchema = z
  .object({
    role: z.enum(TEAM_ROLES).optional(),
    displayName: displayName.optional(),
    digest: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to change.');
export type MemberPatch = z.infer<typeof memberPatchSchema>;

export const joinSchema = z
  .object({
    token: z.string().min(20).max(100),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((input) => input.password === input.confirm, {
    message: 'The two passwords don’t match.',
    path: ['confirm'],
  });

/** An invite link that no longer works (the join page). */
export const INVITE_GONE =
  'This invite has expired or was already used. Ask an Admin for a new link.';

/** How long an invite link works (platform_invite_member). */
export const INVITE_DAYS = 7;
