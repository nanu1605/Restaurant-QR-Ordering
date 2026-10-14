'use server';

import { randomUUID } from 'node:crypto';

import { refresh } from 'next/cache';
import { after } from 'next/server';
import { headers } from 'next/headers';

import {
  actionError,
  actionOk,
  fromDbError,
  fromZodError,
  type ActionResult,
} from '@/lib/action-result';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { dbErrorCode, GENERIC_ERROR } from '@/lib/db-errors';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import { notifySupportRequest } from './notify';
import {
  phoneDigits,
  SCREENSHOT_BUCKET,
  SCREENSHOT_TYPES,
  supportRequestSchema,
  type ScreenshotType,
  type SupportRequestInput,
} from './support';

/**
 * Get help (docs/SUPER_ADMIN_PLAN.md 13b, docs/DECISIONS.md SA-42): the
 * restaurant's owner or a manager asks the MenuMesh team for help.
 */

/** A signed link to upload one screenshot to the restaurant's folder. */
export async function startScreenshotUpload(
  type: string,
): Promise<ActionResult<{ path: string; token: string }>> {
  const membership = await requireMember(ADMIN_PANEL_ROLES);
  const extension = SCREENSHOT_TYPES[type as ScreenshotType];
  if (!extension) return actionError('Choose a PNG, JPEG or WebP image.');
  const path = `${membership.restaurant.id}/${randomUUID()}.${extension}`;
  const signed = await createAdminClient()
    .storage.from(SCREENSHOT_BUCKET)
    .createSignedUploadUrl(path);
  if (signed.error) {
    console.error('[support] could not sign a screenshot upload:', signed.error.message);
    return actionError(GENERIC_ERROR);
  }
  return actionOk({ path, token: signed.data.token });
}

/** Sends the request; the page it came from, the app's version and the browser go with it. */
export async function createSupportRequest(
  input: SupportRequestInput & { screenshotPath: string | null; from: string | null },
): Promise<ActionResult<{ id: string }>> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = supportRequestSchema.safeParse(input);
  if (!parsed.success) return fromZodError(parsed.error);
  const request = parsed.data;
  const from =
    typeof input.from === 'string' && input.from.startsWith('/admin') ? input.from : null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_create_support_request', {
    p_request: {
      topic: request.topic,
      message: request.message,
      contact_method: request.contact_method,
      contact: request.contact_method === 'email' ? request.contact : phoneDigits(request.contact),
      screenshot_path: typeof input.screenshotPath === 'string' ? input.screenshotPath : null,
      context: {
        page: from?.slice(0, 200) ?? null,
        app_version: process.env.NEXT_PUBLIC_BUILD_SHA?.slice(0, 40) ?? null,
        browser: (await headers()).get('user-agent')?.slice(0, 300) ?? null,
      },
    },
  });
  if (error) {
    if (dbErrorCode(error) === 'RATE_LIMITED') {
      return actionError('That is 10 requests in an hour. Wait a little, or call us.');
    }
    if (error.details === 'screenshot_path') {
      return actionError('The screenshot did not upload. Remove it and try again.');
    }
    return fromDbError(error, 'admin_create_support_request');
  }
  after(() => notifySupportRequest(data));
  refresh();
  return actionOk({ id: data });
}
