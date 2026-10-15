'use server';

import { redirect } from 'next/navigation';

import { INVITE_GONE, joinSchema } from '@/features/platform/team';
import { dbErrorCode, GENERIC_ERROR } from '@/lib/db-errors';
import { hashCode } from '@/lib/one-time-code';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

type JoinField = 'password' | 'confirm';
export type JoinState = { error?: string; fieldErrors?: Partial<Record<JoinField, string>> } | null;

/**
 * Joining the team from an invite (docs/DECISIONS.md SA-70+): the password is
 * saved, the invite spent, and the member signed in; /super then asks them to
 * set up the second factor.
 */
export async function joinTeam(_previous: JoinState, formData: FormData): Promise<JoinState> {
  const parsed = joinSchema.safeParse({
    token: String(formData.get('token') ?? ''),
    password: String(formData.get('password') ?? ''),
    confirm: String(formData.get('confirm') ?? ''),
  });
  if (!parsed.success) {
    const fieldErrors: Partial<Record<JoinField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === 'password' || field === 'confirm') fieldErrors[field] ??= issue.message;
      else return { error: INVITE_GONE };
    }
    return { fieldErrors };
  }

  const hash = hashCode('team-invite', parsed.data.token);
  const admin = createAdminClient();
  const { data: invite, error } = await admin.rpc('platform_invite_lookup', {
    p_token_hash: hash,
  });
  const found = invite as { user_id: string; email: string; expired: boolean } | null;
  if (error) {
    console.error('[team] could not read an invite', error.code, error.message);
    return { error: GENERIC_ERROR };
  }
  if (!found || found.expired) return { error: INVITE_GONE };

  // The invite isn't spent until the password is saved, so a refused one can be tried again.
  const { error: updateError } = await admin.auth.admin.updateUserById(found.user_id, {
    password: parsed.data.password,
  });
  if (updateError) {
    if (updateError.code === 'weak_password') {
      return { fieldErrors: { password: 'Choose a longer, harder to guess password.' } };
    }
    console.error('[team] password not saved:', updateError.code, updateError.message);
    return { error: GENERIC_ERROR };
  }
  const accepted = await admin.rpc('platform_invite_accept', { p_token_hash: hash });
  if (accepted.error) {
    if (dbErrorCode(accepted.error) === 'INVITE_INVALID') return { error: INVITE_GONE };
    console.error('[team] could not accept an invite', accepted.error);
    return { error: GENERIC_ERROR };
  }

  const supabase = await createClient();
  const signIn = await supabase.auth.signInWithPassword({
    email: found.email,
    password: parsed.data.password,
  });
  if (signIn.error) {
    console.error('[team] sign-in after joining failed', signIn.error);
    redirect('/login?error=password_changed');
  }
  redirect('/super/mfa');
}
