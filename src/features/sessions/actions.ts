'use server';

import { z } from 'zod';

import { reasonSchema } from '@/features/orders/schemas';
import { actionOk, fromDbError, fromZodError, type ActionResult } from '@/lib/action-result';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES } from '@/lib/auth/roles';
import { dbErrorCode, dbErrorMessage } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

/**
 * Table sessions on the live board (spec §9.3, §10.1, §10.7): closing a table
 * without a bill, and waiter assignment. The database functions own the rules.
 */

/** Waiters close tables with nothing accepted; managers and owners close any (spec §9.3). */
const CLOSER_ROLES = ['owner', 'manager', 'waiter'] as const;

const invalid = () => fromDbError({ code: 'P0001', message: 'INVALID_INPUT' }, 'session input');

export async function closeSessionUnbilled(
  sessionId: string,
  reason: string,
): Promise<ActionResult> {
  await requireMember(CLOSER_ROLES);
  const parsed = z
    .object({ sessionId: z.uuid(), reason: reasonSchema })
    .safeParse({ sessionId, reason });
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('staff_close_session_unbilled', {
    p_session_id: parsed.data.sessionId,
    p_reason: parsed.data.reason,
  });
  if (error) return fromDbError(error, 'staff_close_session_unbilled');
  return actionOk();
}

export type AssignWaiterResult =
  | { ok: true; data: { approvedOrders: number } }
  | { ok: false; error: string; busyTables?: string[] };

const assignedJson = z.object({ approved_orders: z.number().int() });

/**
 * Assign or reassign a waiter. A busy waiter (at the table limit) comes back
 * with the tables they're handling, so the screen can ask "Assign anyway?" and
 * retry with `force` (spec §10.7).
 */
export async function assignWaiter(
  sessionId: string,
  waiterId: string,
  force = false,
): Promise<AssignWaiterResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = z
    .object({ sessionId: z.uuid(), waiterId: z.uuid(), force: z.boolean() })
    .safeParse({ sessionId, waiterId, force });
  if (!parsed.success) return invalid();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_assign_waiter', {
    p_session_id: parsed.data.sessionId,
    p_waiter_id: parsed.data.waiterId,
    p_force: parsed.data.force,
  });
  if (error) {
    if (dbErrorCode(error) === 'WAITER_BUSY') {
      return {
        ok: false,
        error: dbErrorMessage(error)!,
        busyTables: (error.details ?? '')
          .split(',')
          .map((label) => label.trim())
          .filter(Boolean),
      };
    }
    return fromDbError(error, 'admin_assign_waiter');
  }
  return actionOk({ approvedOrders: assignedJson.parse(data).approved_orders });
}

export async function unassignWaiter(sessionId: string): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  if (!z.uuid().safeParse(sessionId).success) return invalid();
  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_unassign_waiter', { p_session_id: sessionId });
  if (error) return fromDbError(error, 'admin_unassign_waiter');
  return actionOk();
}

/** Move a table's guests to a free table (spec §9.3 staff_move_session, P9-3). */
export async function moveSession(
  sessionId: string,
  tableId: string,
): Promise<ActionResult<{ table: string }>> {
  await requireMember(CLOSER_ROLES);
  const parsed = z
    .object({ sessionId: z.uuid(), tableId: z.uuid() })
    .safeParse({ sessionId, tableId });
  if (!parsed.success) return invalid();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('staff_move_session', {
    p_session_id: parsed.data.sessionId,
    p_target_table_id: parsed.data.tableId,
  });
  if (error) return fromDbError(error, 'staff_move_session');
  return actionOk({ table: z.object({ table: z.string() }).parse(data).table });
}

/** Acknowledge or finish a customer's call or bill request (P9-1). */
export async function updateServiceRequest(
  requestId: string,
  status: 'acknowledged' | 'resolved',
): Promise<ActionResult> {
  await requireMember(CLOSER_ROLES);
  const parsed = z
    .object({ requestId: z.uuid(), status: z.enum(['acknowledged', 'resolved']) })
    .safeParse({ requestId, status });
  if (!parsed.success) return invalid();
  const supabase = await createClient();
  const { error } = await supabase.rpc('staff_update_service_request', {
    p_request_id: parsed.data.requestId,
    p_status: parsed.data.status,
  });
  if (error) return fromDbError(error, 'staff_update_service_request');
  return actionOk();
}
