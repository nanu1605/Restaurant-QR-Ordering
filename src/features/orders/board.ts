import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import type { FoodType } from '@/components/shared/food-type-mark';
import type { MemberRole } from '@/lib/auth/roles';
import { ORDER_ITEM_STATUSES, type OrderItemStatus } from '@/lib/order-status';
import { Constants, type Database } from '@/types/database';

/**
 * The live board (staff_get_board, spec §12–§13.3): every table, its open
 * session's rounds and dishes, the waiters and the settings the screens need.
 * Shared by the server (first render) and the browser (TanStack Query), and
 * parsed with zod so a schema drift fails loudly instead of rendering nonsense.
 */

export type OrderStatus = Database['public']['Enums']['order_status'];

export type BoardItem = {
  id: string;
  name: string;
  variant: string | null;
  foodType: FoodType;
  quantity: number;
  note: string | null;
  status: OrderItemStatus;
  removedReason: string | null;
  removedByName: string | null;
};

export type BoardRound = {
  id: string;
  roundNumber: number;
  status: OrderStatus;
  placedVia: 'customer' | 'staff';
  createdAt: string;
  /** When the kitchen could start it: approval time, or placement if accepted at once. */
  acceptedAt: string | null;
  customerNote: string | null;
  rejectReason: string | null;
  removedReason: string | null;
  removedByName: string | null;
  /** Waiting for approval with at least one dish still ordered (P3-5). */
  isWaiting: boolean;
  items: BoardItem[];
};

export type BoardSession = {
  id: string;
  openedAt: string;
  isApproved: boolean;
  assignedWaiterId: string | null;
  /** Rounds waiting for approval; kitchen users get the count but not the rounds. */
  waitingCount: number;
  rounds: BoardRound[];
};

export type BoardTable = {
  id: string;
  label: string;
  sortOrder: number;
  session: BoardSession | null;
};

export type BoardWaiter = { id: string; name: string; onDuty: boolean };

export type Board = {
  /** Server clock, so elapsed times don't depend on the device's clock. */
  now: string;
  timezone: string;
  role: MemberRole;
  /** The caller's own waiter profile, for "My tables". */
  myWaiterId: string | null;
  /** False while the restaurant is read-only: no new orders (spec §10.6). */
  canOrder: boolean;
  settings: {
    requireFirstOrderApproval: boolean;
    maxTablesPerWaiter: number;
    staffCanRemoveServedItems: boolean;
  };
  tables: BoardTable[];
  waiters: BoardWaiter[];
};

const itemJson = z.object({
  id: z.string(),
  name: z.string(),
  variant: z.string().nullable(),
  food_type: z.enum(Constants.public.Enums.food_type),
  quantity: z.number().int(),
  note: z.string().nullable(),
  status: z.enum(ORDER_ITEM_STATUSES),
  removed_reason: z.string().nullable(),
  removed_by_name: z.string().nullable(),
});

const roundJson = z.object({
  id: z.string(),
  round_number: z.number().int(),
  status: z.enum(Constants.public.Enums.order_status),
  placed_via: z.enum(Constants.public.Enums.order_placed_via),
  created_at: z.string(),
  accepted_at: z.string().nullable(),
  customer_note: z.string().nullable(),
  reject_reason: z.string().nullable(),
  removed_reason: z.string().nullable(),
  removed_by_name: z.string().nullable(),
  is_waiting: z.boolean(),
  items: z.array(itemJson),
});

const boardJson = z.object({
  now: z.string(),
  timezone: z.string(),
  role: z.enum(Constants.public.Enums.member_role),
  my_waiter_id: z.string().nullable(),
  access_state: z.enum(['full', 'read_only']),
  settings: z.object({
    require_first_order_approval: z.boolean(),
    max_tables_per_waiter: z.number().int(),
    staff_can_remove_served_items: z.boolean(),
  }),
  tables: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      sort_order: z.number().int(),
      session: z
        .object({
          id: z.string(),
          opened_at: z.string(),
          is_approved: z.boolean(),
          assigned_waiter_id: z.string().nullable(),
          waiting_count: z.number().int(),
          rounds: z.array(roundJson),
        })
        .nullable(),
    }),
  ),
  waiters: z.array(z.object({ id: z.string(), name: z.string(), on_duty: z.boolean() })),
});

export function parseBoard(json: unknown): Board {
  const data = boardJson.parse(json);
  return {
    now: data.now,
    timezone: data.timezone,
    role: data.role,
    myWaiterId: data.my_waiter_id,
    canOrder: data.access_state === 'full',
    settings: {
      requireFirstOrderApproval: data.settings.require_first_order_approval,
      maxTablesPerWaiter: data.settings.max_tables_per_waiter,
      staffCanRemoveServedItems: data.settings.staff_can_remove_served_items,
    },
    tables: data.tables.map((table) => ({
      id: table.id,
      label: table.label,
      sortOrder: table.sort_order,
      session: table.session && {
        id: table.session.id,
        openedAt: table.session.opened_at,
        isApproved: table.session.is_approved,
        assignedWaiterId: table.session.assigned_waiter_id,
        waitingCount: table.session.waiting_count,
        rounds: table.session.rounds.map((round) => ({
          id: round.id,
          roundNumber: round.round_number,
          status: round.status,
          placedVia: round.placed_via,
          createdAt: round.created_at,
          acceptedAt: round.accepted_at,
          customerNote: round.customer_note,
          rejectReason: round.reject_reason,
          removedReason: round.removed_reason,
          removedByName: round.removed_by_name,
          isWaiting: round.is_waiting,
          items: round.items.map((item) => ({
            id: item.id,
            name: item.name,
            variant: item.variant,
            foodType: item.food_type,
            quantity: item.quantity,
            note: item.note,
            status: item.status,
            removedReason: item.removed_reason,
            removedByName: item.removed_by_name,
          })),
        })),
      },
    })),
    waiters: data.waiters.map((waiter) => ({
      id: waiter.id,
      name: waiter.name,
      onDuty: waiter.on_duty,
    })),
  };
}

/** One board read; the caller's session and RLS decide what comes back. */
export async function fetchBoard(client: SupabaseClient<Database>): Promise<Board> {
  const { data, error } = await client.rpc('staff_get_board');
  if (error) throw new Error(`staff_get_board failed: ${error.code} ${error.message}`);
  return parseBoard(data);
}
