'use server';

import { z } from 'zod';

import { refusedLines } from '@/features/ordering/addons';
import { toOrderItemsPayload } from '@/features/ordering/schemas';
import { actionOk, fromDbError, fromZodError, type ActionResult } from '@/lib/action-result';
import { requireMember } from '@/lib/auth/guards';
import { ADMIN_PANEL_ROLES, STAFF_PANEL_ROLES } from '@/lib/auth/roles';
import { dbErrorCode, dbErrorMessage } from '@/lib/db-errors';
import { createClient } from '@/lib/supabase/server';

import {
  forwardStatusSchema,
  idSchema,
  itemIdsSchema,
  reasonSchema,
  removeItemSchema,
  staffOrderSchema,
  type ForwardStatus,
  type RemoveItemInput,
  type StaffOrderInput,
} from './schemas';
import { fetchStaffMenu } from './staff-menu';

/**
 * Live board actions (spec §9.3, §13.2, §13.3). Every one re-checks the caller
 * and validates its input; the database functions check the role again and
 * own the rules. No refresh(): the board is a client query that refetches
 * after each change (docs/DECISIONS.md P4-19).
 */

/** Waiters, managers and owners approve and reject (spec §3). */
const APPROVER_ROLES = ['owner', 'manager', 'waiter'] as const;

const invalid = () => fromDbError({ code: 'P0001', message: 'INVALID_INPUT' }, 'board input');

export async function approveOrder(orderId: string): Promise<ActionResult> {
  await requireMember(APPROVER_ROLES);
  if (!idSchema.safeParse(orderId).success) return invalid();
  const supabase = await createClient();
  const { error } = await supabase.rpc('staff_approve_order', { p_order_id: orderId });
  if (error) return fromDbError(error, 'staff_approve_order');
  return actionOk();
}

export async function rejectOrder(orderId: string, reason: string): Promise<ActionResult> {
  await requireMember(APPROVER_ROLES);
  const parsed = z
    .object({ orderId: idSchema, reason: reasonSchema })
    .safeParse({ orderId, reason });
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('staff_reject_order', {
    p_order_id: parsed.data.orderId,
    p_reason: parsed.data.reason,
  });
  if (error) return fromDbError(error, 'staff_reject_order');
  return actionOk();
}

/**
 * Moves dishes forward — one tap on a dish, or a whole kitchen ticket at once.
 * A dish already past the target is done, not an error: a move replayed after
 * a network loss must not complain (docs/DECISIONS.md P9-5). For a ticket,
 * dishes cancelled meanwhile are simply skipped.
 */
export async function setItemsStatus(
  itemIds: string[],
  status: ForwardStatus,
): Promise<ActionResult> {
  await requireMember(STAFF_PANEL_ROLES);
  const ids = itemIdsSchema.safeParse(itemIds);
  const target = forwardStatusSchema.safeParse(status);
  if (!ids.success || !target.success) return invalid();

  const supabase = await createClient();
  const results = await Promise.all(
    ids.data.map((id) =>
      supabase.rpc('staff_update_item_status', { p_order_item_id: id, p_status: target.data }),
    ),
  );
  const skippable = ['INVALID_STATUS_CHANGE', ...(ids.data.length > 1 ? ['ITEM_NOT_ACTIVE'] : [])];
  const failure = results.find(
    ({ error }) => error && !skippable.includes(dbErrorCode(error) ?? ''),
  );
  if (failure?.error) return fromDbError(failure.error, 'staff_update_item_status');
  return actionOk();
}

export async function markOrderServed(orderId: string): Promise<ActionResult> {
  await requireMember(STAFF_PANEL_ROLES);
  if (!idSchema.safeParse(orderId).success) return invalid();
  const supabase = await createClient();
  const { error } = await supabase.rpc('staff_mark_order_served', { p_order_id: orderId });
  if (error) return fromDbError(error, 'staff_mark_order_served');
  return actionOk();
}

/** One step back; managers and owners only (spec §10.3). */
export async function revertItemStatus(
  itemId: string,
  fromStatus: ForwardStatus,
): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  if (!idSchema.safeParse(itemId).success || !forwardStatusSchema.safeParse(fromStatus).success) {
    return invalid();
  }
  const supabase = await createClient();
  // The status the manager saw: if it has moved since, nothing changes.
  const { error } = await supabase.rpc('staff_revert_item_status', {
    p_order_item_id: itemId,
    p_from_status: fromStatus,
  });
  if (error) return fromDbError(error, 'staff_revert_item_status');
  return actionOk();
}

/**
 * The in-stock switch on the worker panel's Availability page. Same database
 * function as the admin menu's switch, but without refresh(): the page's menu
 * query updates itself, and a refresh would re-render the whole live layout.
 */
export async function setDishAvailability(id: string, available: boolean): Promise<ActionResult> {
  await requireMember(STAFF_PANEL_ROLES);
  const parsed = z.object({ id: idSchema, available: z.boolean() }).safeParse({ id, available });
  if (!parsed.success) return invalid();
  const supabase = await createClient();
  const { error } = await supabase.rpc('staff_set_item_availability', {
    p_item_id: parsed.data.id,
    p_available: parsed.data.available,
  });
  if (error) return fromDbError(error, 'staff_set_item_availability');
  return actionOk();
}

/** The in-stock switch for one add-on option (docs/DECISIONS.md P9-4), like dishes. */
export async function setAddonAvailability(id: string, available: boolean): Promise<ActionResult> {
  await requireMember(STAFF_PANEL_ROLES);
  const parsed = z.object({ id: idSchema, available: z.boolean() }).safeParse({ id, available });
  if (!parsed.success) return invalid();
  const supabase = await createClient();
  const { error } = await supabase.rpc('staff_set_addon_availability', {
    p_addon_id: parsed.data.id,
    p_available: parsed.data.available,
  });
  if (error) return fromDbError(error, 'staff_set_addon_availability');
  return actionOk();
}

export async function removeItem(input: RemoveItemInput): Promise<ActionResult> {
  await requireMember(STAFF_PANEL_ROLES);
  const parsed = removeItemSchema.safeParse(input);
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('staff_remove_item', {
    p_order_item_id: parsed.data.itemId,
    p_quantity: parsed.data.quantity,
    p_reason: parsed.data.reason,
  });
  if (error) return fromDbError(error, 'staff_remove_item');
  return actionOk();
}

/** Delete a whole round; managers and owners only (spec §10.8). */
export async function removeOrder(orderId: string, reason: string): Promise<ActionResult> {
  await requireMember(ADMIN_PANEL_ROLES);
  const parsed = z
    .object({ orderId: idSchema, reason: reasonSchema })
    .safeParse({ orderId, reason });
  if (!parsed.success) return fromZodError(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('admin_remove_order', {
    p_order_id: parsed.data.orderId,
    p_reason: parsed.data.reason,
  });
  if (error) return fromDbError(error, 'admin_remove_order');
  return actionOk();
}

const placedJson = z.object({
  order_id: z.string(),
  session_id: z.string(),
  round_number: z.number().int(),
  assigned_waiter_id: z.string().nullable(),
});

export type StaffOrderResult =
  | { ok: true; data: { orderId: string; roundNumber: number; assignedWaiterId: string | null } }
  /** unavailableLines: indexes of the sent lines to take out of the round. */
  | { ok: false; error: string; code?: string; detail?: string; unavailableLines?: number[] };

/** "Add dishes" / "Add order" (spec §10.8): a new round, or a full order for a free table. */
export async function placeStaffOrder(input: StaffOrderInput): Promise<StaffOrderResult> {
  await requireMember(STAFF_PANEL_ROLES);
  const parsed = staffOrderSchema.safeParse(input);
  if (!parsed.success) return invalid();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('staff_place_order', {
    p_dining_table_id: parsed.data.tableId,
    p_items: toOrderItemsPayload(parsed.data.lines),
    p_idempotency_key: parsed.data.idempotencyKey,
    p_note: parsed.data.note ?? undefined,
  });
  if (error) {
    if (dbErrorCode(error) === 'ITEM_UNAVAILABLE') {
      const menu = await fetchStaffMenu(supabase).catch(() => []);
      return {
        ok: false,
        error: dbErrorMessage(error)!,
        code: 'ITEM_UNAVAILABLE',
        unavailableLines: refusedLines(
          menu,
          parsed.data.lines,
          (error.details ?? '').split(',').filter(Boolean),
        ),
      };
    }
    return fromDbError(error, 'staff_place_order');
  }

  const placed = placedJson.parse(data);
  return actionOk({
    orderId: placed.order_id,
    roundNumber: placed.round_number,
    assignedWaiterId: placed.assigned_waiter_id,
  });
}
