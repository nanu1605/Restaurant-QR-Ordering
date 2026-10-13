'use client';

import { cn } from 'cn';
import { ArrowRightLeft, Plus, Trash2, Undo2, XIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { StatusChip } from '@/components/shared/status-chip';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useOffline } from '@/features/live/live-provider';
import { randomUuid } from '@/features/ordering/cart';
import { dishName, formatClockTime } from '@/features/ordering/format';
import { WaiterAssignment } from '@/features/sessions/components/waiter-assignment';
import { closeSessionUnbilled } from '@/features/sessions/actions';
import { ORDER_ITEM_STATUS_LABELS, isVoidStatus } from '@/lib/order-status';

import { approveOrder, rejectOrder, removeOrder, revertItemStatus } from '../actions';
import type { Board, BoardItem, BoardRound, BoardTable } from '../board';
import {
  type ActiveStatus,
  activeItems,
  isActiveStatus,
  minutesSince,
  nextStatus,
  tableState,
  waiterName,
} from '../board-view';
import { withItemStatus } from '../optimistic';
import { REJECT_REASONS, type ForwardStatus } from '../schemas';
import { useStaffStrings } from '../staff-lang';
import type { StaffStrings } from '../strings';
import { useBoardAction, useStatusChange } from '../use-board';
import { AddDishesSheet } from './add-dishes-sheet';
import type { BoardMode } from './live-board';
import { MoveTableDialog } from './move-table-dialog';
import { OfflineBanner } from './offline-banner';
import { ReasonDialog } from './reason-dialog';
import { RemoveItemDialog } from './remove-item-dialog';
import { RequestBadges, RequestsSection } from './table-requests';
import { TableStateBadge } from './table-state-badge';

const PREVIOUS: Partial<Record<ActiveStatus, ActiveStatus>> = {
  preparing: 'placed',
  ready: 'preparing',
  served: 'ready',
};

type TableDrawerProps = {
  board: Board;
  mode: BoardMode;
  tableId: string | null;
  nowMs: number;
  onClose: () => void;
};

/**
 * A table's rounds and dishes (spec §13.2): waiting orders first with Approve
 * / Reject, then every round with one-tap status buttons, Remove dish, Add
 * dishes and Close without bill. Reads the live board, so it updates in place.
 */
export function TableDrawer({ board, mode, tableId, nowMs, onClose }: TableDrawerProps) {
  const table = board.tables.find((t) => t.id === tableId) ?? null;
  const t = useStaffStrings();

  return (
    <Sheet open={table !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full gap-0 overflow-y-auto sm:max-w-lg"
      >
        {table && (
          <DrawerBody
            key={table.id}
            board={board}
            mode={mode}
            table={table}
            nowMs={nowMs}
            onClose={onClose}
          />
        )}
        <SheetClose
          render={<Button variant="ghost" size="icon-touch" className="absolute top-2 right-2" />}
        >
          <XIcon aria-hidden />
          <span className="sr-only">{t.close}</span>
        </SheetClose>
      </SheetContent>
    </Sheet>
  );
}

type DrawerBodyProps = {
  board: Board;
  mode: BoardMode;
  table: BoardTable;
  nowMs: number;
  onClose: () => void;
};

function DrawerBody({ board, mode, table, nowMs, onClose }: DrawerBodyProps) {
  const [adding, setAdding] = useState(false);
  const [rejecting, setRejecting] = useState<BoardRound | null>(null);
  const [deleting, setDeleting] = useState<BoardRound | null>(null);
  const [removing, setRemoving] = useState<BoardItem | null>(null);
  const [closing, setClosing] = useState(false);
  // The session the Move dialog was opened for.
  const [moving, setMoving] = useState<string | null>(null);
  // Only dish status moves wait for the network (docs/DECISIONS.md P9-5).
  const offline = useOffline();
  const t = useStaffStrings();

  const approve = useBoardAction({
    action: (orderId: string) => approveOrder(orderId),
    successMessage: () => t.drawer.approved,
  });
  const reject = useBoardAction({
    action: ({ orderId, reason }: { orderId: string; reason: string }) =>
      rejectOrder(orderId, reason),
  });
  const deleteOrder = useBoardAction({
    action: ({ orderId, reason }: { orderId: string; reason: string }) =>
      removeOrder(orderId, reason),
  });
  const close = useBoardAction({
    action: ({ sessionId, reason }: { sessionId: string; reason: string }) =>
      closeSessionUnbilled(sessionId, reason),
  });

  const session = table.session;
  const state = tableState(table);
  const role = board.role;
  const isManager = role === 'owner' || role === 'manager';
  const heading = t.table(table.label);
  const waiting = session?.rounds.filter((round) => round.isWaiting) ?? [];
  const rounds = session?.rounds.filter((round) => !round.isWaiting) ?? [];
  const accepted = rounds.flatMap(activeItems);
  const onTheWay = accepted.filter((item) => item.status !== 'served');
  // Waiters close tables with nothing accepted; managers close any (spec §9.3, §13.2).
  const canClose = session !== null && role !== 'kitchen' && (isManager || accepted.length === 0);
  const waiter = session ? waiterName(board, session.assignedWaiterId) : null;

  return (
    <>
      <SheetHeader className="gap-2 border-b border-line pr-14">
        <SheetTitle className="flex flex-wrap items-center gap-3 text-2xl font-bold text-ink">
          {heading}
          <TableStateBadge state={state} label={t.tableState[state]} />
          <RequestBadges requests={table.requests} />
        </SheetTitle>
        <SheetDescription className="text-sm text-ink-muted">
          {session
            ? t.drawer.seatedAgo(t.elapsed(minutesSince(session.openedAt, nowMs)))
            : t.drawer.free}
        </SheetDescription>
        {session &&
          (mode === 'admin' && isManager ? (
            <WaiterAssignment board={board} table={table} />
          ) : (
            <p className="text-sm text-ink">
              {t.drawer.waiter}{' '}
              {waiter ? (
                <span className="font-semibold">{waiter}</span>
              ) : (
                <span className="font-semibold text-attention">{t.drawer.unassigned}</span>
              )}
            </p>
          ))}
      </SheetHeader>

      <div className="flex flex-col gap-4 p-4">
        {/* The modal drawer hides the page's banner. */}
        <OfflineBanner />
        <RequestsSection table={table} nowMs={nowMs} />

        {session && session.waitingCount > 0 && waiting.length === 0 && (
          <p className="rounded-lg border border-attention px-3 py-2 text-sm text-ink">
            {t.drawer.waitingElsewhere(session.waitingCount)}
          </p>
        )}

        {waiting.map((round) => (
          <section
            key={round.id}
            aria-label={t.drawer.waitingRound(round.roundNumber)}
            className="flex flex-col gap-3 rounded-lg border-2 border-attention bg-surface p-3"
          >
            <RoundHeading
              round={round}
              timezone={board.timezone}
              label={t.drawer.waitingForApproval}
            />
            {round.customerNote && (
              <p className="text-sm text-ink">{t.drawer.note(round.customerNote)}</p>
            )}
            <ul className="flex flex-col">
              {round.items.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-2 py-1">
                  <ItemName item={item} />
                  {isVoidStatus(item.status) && (
                    <StatusChip status={item.status} label={t.status[item.status]} />
                  )}
                </li>
              ))}
            </ul>
            {role !== 'kitchen' && (
              <div className="flex flex-wrap gap-2">
                <Button size="touch" disabled={offline} onClick={() => approve.mutate(round.id)}>
                  {t.drawer.approve}
                  <span className="sr-only">{t.drawer.roundSuffix(round.roundNumber)}</span>
                </Button>
                <Button
                  size="touch"
                  variant="outline"
                  disabled={offline}
                  onClick={() => setRejecting(round)}
                >
                  {t.drawer.reject}
                  <span className="sr-only">{t.drawer.roundSuffix(round.roundNumber)}</span>
                </Button>
                {mode === 'admin' && isManager && (
                  <Button
                    size="touch"
                    variant="ghost"
                    className="text-status-void"
                    disabled={offline}
                    onClick={() => setDeleting(round)}
                  >
                    <Trash2 aria-hidden />
                    Delete order<span className="sr-only"> round {round.roundNumber}</span>
                  </Button>
                )}
              </div>
            )}
          </section>
        ))}

        {rounds.map((round) => (
          <RoundSection
            key={round.id}
            round={round}
            board={board}
            mode={mode}
            onRemoveItem={setRemoving}
            onDelete={() => setDeleting(round)}
          />
        ))}

        {!session && (
          <p className="text-base text-ink">
            {board.canOrder ? t.drawer.openToOrder : t.drawer.paused}
          </p>
        )}
      </div>

      <SheetFooter className="sticky bottom-0 border-t border-line bg-surface">
        <Button size="touch" onClick={() => setAdding(true)} disabled={!board.canOrder || offline}>
          <Plus aria-hidden />
          {session ? t.drawer.addDishes : t.drawer.addOrder}
        </Button>
        {!board.canOrder && session && (
          <p className="text-sm text-ink-muted">{t.drawer.pausedServe}</p>
        )}
        {session && role !== 'kitchen' && (
          <Button
            size="touch"
            variant="outline"
            disabled={offline}
            onClick={() => setMoving(session.id)}
          >
            <ArrowRightLeft aria-hidden />
            {t.drawer.moveTable}
          </Button>
        )}
        {canClose && (
          <Button
            size="touch"
            variant="outline"
            disabled={offline}
            onClick={() => setClosing(true)}
          >
            {t.drawer.closeWithoutBill}
          </Button>
        )}
      </SheetFooter>

      {session && (
        <MoveTableDialog
          board={board}
          table={table}
          sessionId={session.id}
          open={moving === session.id}
          onOpenChange={(open) => setMoving(open ? session.id : null)}
          onMoved={onClose}
        />
      )}

      <AddDishesSheet
        board={board}
        table={adding ? table : null}
        onClose={() => setAdding(false)}
      />

      <ReasonDialog
        open={rejecting !== null}
        onOpenChange={(open) => !open && setRejecting(null)}
        title={t.drawer.rejectTitle(rejecting?.roundNumber ?? 0)}
        description={t.drawer.rejectDescription}
        presets={REJECT_REASONS}
        confirmLabel={t.drawer.rejectConfirm}
        destructive
        onConfirm={async (reason) => {
          if (!rejecting) return true;
          try {
            await reject.mutateAsync({ orderId: rejecting.id, reason });
            toast.success(t.drawer.rejected);
            return true;
          } catch {
            return false;
          }
        }}
      />

      <ReasonDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete round ${deleting?.roundNumber ?? ''}`}
        description="All its dishes are removed, served ones too. They stay visible, struck through with your reason."
        confirmLabel="Delete order"
        destructive
        onConfirm={async (reason) => {
          if (!deleting) return true;
          try {
            await deleteOrder.mutateAsync({ orderId: deleting.id, reason });
            toast.success(`Round ${deleting.roundNumber} deleted`);
            return true;
          } catch {
            return false;
          }
        }}
      />

      <RemoveItemDialog item={removing} onClose={() => setRemoving(null)} />

      <ReasonDialog
        open={closing}
        onOpenChange={setClosing}
        title={t.drawer.closeTitle(heading)}
        description={
          onTheWay.length > 0 ? t.drawer.closeOnTheWay(onTheWay.length) : t.drawer.closeEmpty
        }
        confirmLabel={t.drawer.closeConfirm}
        destructive
        onConfirm={async (reason) => {
          if (!session) return true;
          try {
            await close.mutateAsync({ sessionId: session.id, reason });
            toast.success(t.drawer.closed(heading));
            onClose();
            return true;
          } catch {
            return false;
          }
        }}
      />
    </>
  );
}

function RoundHeading({
  round,
  timezone,
  label,
}: {
  round: BoardRound;
  timezone: string;
  label?: string;
}) {
  const t = useStaffStrings();
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-base font-semibold text-ink">
        {t.drawer.round(round.roundNumber)}{' '}
        <span className="font-normal text-ink-muted">
          · {formatClockTime(round.createdAt, timezone)} ·{' '}
          {round.placedVia === 'staff' ? t.drawer.addedByStaff : t.drawer.customer}
        </span>
      </h3>
      {label && <span className="text-sm font-semibold text-attention">{label}</span>}
    </div>
  );
}

function roundLabel(round: BoardRound, t: StaffStrings): string | undefined {
  if (round.status === 'rejected') return t.drawer.roundRejected;
  if (round.status === 'removed') return t.drawer.roundDeleted;
  if (round.status === 'pending_approval') return t.drawer.roundCancelled;
  return undefined;
}

type RoundSectionProps = {
  round: BoardRound;
  board: Board;
  mode: BoardMode;
  onRemoveItem: (item: BoardItem) => void;
  onDelete: () => void;
};

function RoundSection({ round, board, mode, onRemoveItem, onDelete }: RoundSectionProps) {
  const serveRound = useStatusChange();
  const offline = useOffline();
  const t = useStaffStrings();
  const isManager = board.role === 'owner' || board.role === 'manager';
  const accepted = round.status === 'accepted';
  const onTheWay = activeItems(round).filter((item) => item.status !== 'served');
  const label = roundLabel(round, t);
  const canServeAll = accepted && onTheWay.length > 1;
  // Waiting rounds are deleted from the waiting section above; a pending round
  // shown here was cancelled by the customer and has nothing left to delete.
  const canDelete = mode === 'admin' && isManager && accepted;

  return (
    <section
      aria-label={t.drawer.round(round.roundNumber)}
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-line bg-surface p-3',
        !accepted && 'bg-paper',
      )}
    >
      <RoundHeading round={round} timezone={board.timezone} label={label} />
      {round.customerNote && (
        <p className="text-sm text-ink">{t.drawer.note(round.customerNote)}</p>
      )}
      {round.status === 'rejected' && round.rejectReason && (
        <p className="text-sm text-status-void">
          {t.drawer.rejectedReason(t.reason.text(round.rejectReason))}
        </p>
      )}
      {round.status === 'removed' && round.removedReason && (
        <p className="text-sm text-status-void">
          {t.drawer.deletedBy(round.removedByName, t.reason.text(round.removedReason))}
        </p>
      )}

      <ul className="flex flex-col">
        {round.items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            actionable={accepted}
            board={board}
            mode={mode}
            onRemove={() => onRemoveItem(item)}
          />
        ))}
      </ul>

      {(canServeAll || canDelete) && (
        <div className="flex flex-wrap gap-2 border-t border-line pt-2">
          {canServeAll && (
            <Button
              size="touch"
              variant="outline"
              onClick={() => serveRound.mutate({ key: randomUuid(), orderId: round.id })}
            >
              {t.drawer.markAllServed}
              <span className="sr-only">{t.drawer.inRound(round.roundNumber)}</span>
            </Button>
          )}
          {canDelete && (
            <Button
              size="touch"
              variant="ghost"
              className="text-status-void"
              disabled={offline}
              onClick={onDelete}
            >
              <Trash2 aria-hidden />
              Delete order<span className="sr-only"> round {round.roundNumber}</span>
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function ItemName({ item }: { item: BoardItem }) {
  const voided = isVoidStatus(item.status);
  const t = useStaffStrings();
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p
        className={cn(
          'flex items-center gap-2 text-base font-medium text-ink',
          voided && 'text-ink-muted line-through',
        )}
      >
        <FoodTypeMark type={item.foodType} size="sm" label={t.foodType[item.foodType]} />
        <span className="tabular-nums">{item.quantity} ×</span>
        <span className="min-w-0 break-words">
          {item.name}
          {item.variant && <span className="text-ink-muted"> ({item.variant})</span>}
        </span>
      </p>
      {item.addons.length > 0 && (
        <p className={cn('pl-6 text-sm text-ink', voided && 'text-ink-muted line-through')}>
          + {item.addons.join(', ')}
        </p>
      )}
      {item.note && <p className="text-sm text-ink-muted">{t.drawer.note(item.note)}</p>}
      {item.status === 'removed' && (
        <p className="text-sm text-status-void">
          {t.drawer.removedBy(
            item.removedByName,
            item.removedReason && t.reason.text(item.removedReason),
          )}
        </p>
      )}
    </div>
  );
}

type ItemRowProps = {
  item: BoardItem;
  actionable: boolean;
  board: Board;
  mode: BoardMode;
  onRemove: () => void;
};

function ItemRow({ item, actionable, board, mode, onRemove }: ItemRowProps) {
  const advance = useStatusChange();
  const offline = useOffline();
  const t = useStaffStrings();
  const revert = useBoardAction({
    action: ({ from }: { from: ForwardStatus; to: ActiveStatus }) =>
      revertItemStatus(item.id, from),
    // Moves at once, so a second tap reverts from the new status, not twice.
    optimistic: (current, { to }) => withItemStatus(current, [item.id], to),
    successMessage: () => `${item.name} moved back`,
  });

  const isManager = board.role === 'owner' || board.role === 'manager';
  const active = actionable && isActiveStatus(item.status);
  const status = active ? (item.status as ActiveStatus) : null;
  const next = status ? nextStatus(status) : null;
  const previous = status ? PREVIOUS[status] : undefined;
  const canRemove =
    item.status !== 'served' || isManager || board.settings.staffCanRemoveServedItems;
  const name = dishName(item);

  return (
    <li className="flex flex-col gap-2 border-t border-line py-2 first:border-t-0">
      <div className="flex items-start justify-between gap-2">
        <ItemName item={item} />
        <StatusChip status={item.status} label={t.status[item.status]} className="mt-0.5" />
      </div>

      {active && (
        <div className="flex flex-wrap gap-2">
          {next && (
            <Button
              size="touch"
              onClick={() => advance.mutate({ key: randomUuid(), ids: [item.id], status: next })}
            >
              {t.drawer.next[next]}
              <span className="sr-only"> {name}</span>
            </Button>
          )}
          {next && next !== 'served' && (
            <Button
              size="touch"
              variant="outline"
              onClick={() =>
                advance.mutate({ key: randomUuid(), ids: [item.id], status: 'served' })
              }
            >
              {t.drawer.next.served}
              <span className="sr-only"> {name}</span>
            </Button>
          )}
          {mode === 'admin' && isManager && status && status !== 'placed' && previous && (
            <Button
              size="touch"
              variant="ghost"
              disabled={offline}
              onClick={() => revert.mutate({ from: status, to: previous })}
            >
              <Undo2 aria-hidden />
              Revert
              <span className="sr-only">
                {' '}
                {name} to {ORDER_ITEM_STATUS_LABELS[previous]}
              </span>
            </Button>
          )}
          {canRemove ? (
            <Button
              size="touch"
              variant="ghost"
              className="text-status-void"
              disabled={offline}
              onClick={onRemove}
            >
              <Trash2 aria-hidden />
              {t.drawer.remove}
              <span className="sr-only"> {name}</span>
            </Button>
          ) : (
            <Button size="touch" variant="ghost" disabled>
              {t.drawer.askManager}
              <span className="sr-only"> {name}</span>
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
