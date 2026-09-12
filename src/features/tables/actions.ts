'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';

import { actionError, actionOk, fromDbError, type ActionResult } from '@/lib/action-result';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { GENERIC_ERROR } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

import { MAX_LABEL_LENGTH, parseTableLabels } from './labels';

/** Tables & QR server actions (spec §13.3). The database enforces max_tables. */

function firstIssue(error: z.ZodError): ActionResult<never> {
  return actionError(error.issues[0]?.message ?? GENERIC_ERROR);
}

export async function createTables(input: string): Promise<ActionResult<{ count: number }>> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = parseTableLabels(typeof input === 'string' ? input : '');
  if (!parsed.ok) return actionError(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_create_tables', { p_labels: parsed.labels });
  if (error) return fromDbError(error, 'admin_create_tables');
  refresh();
  return actionOk({ count: Array.isArray(data) ? data.length : parsed.labels.length });
}

const labelSchema = z
  .string()
  .trim()
  .min(1, 'Enter a table name.')
  .max(MAX_LABEL_LENGTH, `Table names must be ${MAX_LABEL_LENGTH} characters or fewer.`);

const tablePatchSchema = z
  .object({ label: labelSchema.optional(), isActive: z.boolean().optional() })
  .refine((patch) => patch.label !== undefined || patch.isActive !== undefined);

export async function updateTable(
  id: string,
  patch: { label?: string; isActive?: boolean },
): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsedId = z.uuid().safeParse(id);
  const parsed = tablePatchSchema.safeParse(patch);
  if (!parsedId.success) return firstIssue(parsedId.error);
  if (!parsed.success) return firstIssue(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_update_table', {
    p_table_id: parsedId.data,
    p_patch: {
      ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
      ...(parsed.data.isActive !== undefined ? { is_active: parsed.data.isActive } : {}),
    },
  });
  if (error) return fromDbError(error, 'admin_update_table');
  refresh();
  return actionOk();
}

export async function reorderTables(ids: string[]): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = z.array(z.uuid()).min(1).max(500).safeParse(ids);
  if (!parsed.success) return firstIssue(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_reorder', { p_kind: 'tables', p_ids: parsed.data });
  if (error) return fromDbError(error, 'admin_reorder');
  refresh();
  return actionOk();
}

/** New QR token; printed stickers with the old code stop working. */
export async function regenerateQr(id: string): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return firstIssue(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_regenerate_qr', { p_table_id: parsed.data });
  if (error) return fromDbError(error, 'admin_regenerate_qr');
  refresh();
  return actionOk();
}
