'use server';

import { randomBytes } from 'node:crypto';

import { refresh } from 'next/cache';
import { after } from 'next/server';

import {
  actionError,
  actionOk,
  fromDbError,
  fromZodError,
  type ActionResult,
} from '@/lib/action-result';
import { requirePlatformPermission } from '@/lib/auth/guards';
import { getPlatformAccess } from '@/lib/auth/session';
import { emailConfig, sendEmail } from '@/lib/email/resend';
import { getPublicEnv } from '@/lib/env';
import { hashCode } from '@/lib/one-time-code';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import {
  inviteSchema,
  memberPatchSchema,
  type InviteInput,
  type MemberPatch,
  type TeamRole,
} from './team';
import { teamInviteEmail } from './team-email';

/**
 * The Team page's actions (docs/SUPER_ADMIN_PLAN.md 13g, docs/DECISIONS.md
 * SA-70+): team.manage here, and again in SQL.
 */

export type InviteSent = { link: string; email: string; emailed: boolean };

/** A link that opens the join page; only its hash is stored. */
function inviteLink() {
  const token = randomBytes(32).toString('base64url');
  return {
    hash: hashCode('team-invite', token),
    link: `${getPublicEnv().NEXT_PUBLIC_APP_URL}/login/join?token=${token}`,
  };
}

/** Emails the link after answering; the page shows it to copy either way. */
async function sendInvite(email: string, name: string, role: TeamRole, link: string, key: string) {
  const config = emailConfig();
  if (!config) return false;
  const access = await getPlatformAccess();
  const invitedBy = access?.display_name ?? 'The MenuMesh team';
  after(() =>
    sendEmail(config, {
      ...teamInviteEmail({ name, invitedBy, role, link }),
      to: [email],
      idempotencyKey: key,
    }).catch((error) => console.error('[team] could not send an invite', error)),
  );
  return true;
}

/** Makes the login (no password yet), adds the member, and sends the link. */
export async function inviteMember(input: InviteInput): Promise<ActionResult<InviteSent>> {
  await requirePlatformPermission('team.manage');
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return fromZodError(parsed.error);
  const { email, displayName, role } = parsed.data;

  const admin = createAdminClient();
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error || !created.data.user) {
    if (created.error?.code === 'email_exists') {
      return actionError(
        'That email already has a MenuMesh login. If they’re in the list, use their row; otherwise use another address.',
      );
    }
    console.error('[team] could not create a login', created.error);
    return actionError('Couldn’t add them. Try again.');
  }
  const userId = created.data.user.id;
  const { hash, link } = inviteLink();
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_invite_member', {
    p_user_id: userId,
    p_display_name: displayName,
    p_role: role,
    p_token_hash: hash,
  });
  if (error) {
    // Left behind, the login would block this email from being invited again.
    const removed = await admin.auth.admin.deleteUser(userId);
    if (removed.error)
      console.error('[team] could not remove an unused login', userId, removed.error);
    return fromDbError(error, 'Invite team member');
  }
  const emailed = await sendInvite(email, displayName, role, link, `team-invite/${hash}`);
  refresh();
  return actionOk({ link, email, emailed });
}

/** A fresh link for a member who hasn't joined; the old one stops working. */
export async function renewInvite(userId: string): Promise<ActionResult<InviteSent>> {
  await requirePlatformPermission('team.manage');
  const { hash, link } = inviteLink();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_renew_invite', {
    p_user_id: userId,
    p_token_hash: hash,
  });
  if (error) return fromDbError(error, 'Renew team invite');
  const member = data as { email: string; display_name: string; role: TeamRole };
  const emailed = await sendInvite(
    member.email,
    member.display_name,
    member.role,
    link,
    `team-invite/${hash}`,
  );
  refresh();
  return actionOk({ link, email: member.email, emailed });
}

/** A new role, name or daily digest choice. */
export async function updateMember(userId: string, patch: MemberPatch): Promise<ActionResult> {
  await requirePlatformPermission('team.manage');
  const parsed = memberPatchSchema.safeParse(patch);
  if (!parsed.success) return fromZodError(parsed.error);
  const { role, displayName, digest } = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_update_member', {
    p_user_id: userId,
    p_patch: {
      ...(role && { role }),
      ...(displayName && { display_name: displayName }),
      ...(digest !== undefined && { digest }),
    },
  });
  if (error) return fromDbError(error, 'Update team member');
  refresh();
  return actionOk();
}

/**
 * Turns a member off or back on. Off: the database refuses them at once, and
 * blocks their login and ends its sessions in the same transaction.
 */
export async function setMemberDisabled(userId: string, disabled: boolean): Promise<ActionResult> {
  await requirePlatformPermission('team.manage');
  const supabase = await createClient();
  const { error } = await supabase.rpc('platform_update_member', {
    p_user_id: userId,
    p_patch: { disabled },
  });
  if (error) return fromDbError(error, 'Turn team member off or on');
  refresh();
  return actionOk();
}
