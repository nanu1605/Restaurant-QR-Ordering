'use client';

import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { tableHeading } from '@/features/ordering/format';
import { moveSession } from '@/features/sessions/actions';

import type { Board, BoardTable } from '../board';
import { useBoardAction } from '../use-board';

type MoveTableDialogProps = {
  board: Board;
  table: BoardTable;
  /** The guests being moved: a new party at this table is never moved by mistake. */
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After the move: the table this drawer shows is free now. */
  onMoved: () => void;
};

/** Move a table's guests to a free table (spec §9.3 staff_move_session, P9-3). */
export function MoveTableDialog({
  board,
  table,
  sessionId,
  open,
  onOpenChange,
  onMoved,
}: MoveTableDialogProps) {
  const free = board.tables.filter((t) => t.session === null && t.id !== table.id);
  const move = useBoardAction({
    action: ({ sessionId, tableId }: { sessionId: string; tableId: string }) =>
      moveSession(sessionId, tableId),
  });

  async function moveTo(target: BoardTable) {
    try {
      await move.mutateAsync({ sessionId, tableId: target.id });
    } catch {
      return;
    }
    const heading = tableHeading(target.label);
    // Guests' phones still show the old table's QR code.
    toast.success(`Moved to ${heading}`, {
      description: `Ask the guests to scan the QR code on ${heading}.`,
    });
    onOpenChange(false);
    onMoved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-ink">
            Move {tableHeading(table.label)}
          </DialogTitle>
          <DialogDescription>
            Choose a free table. The orders, waiter and bill move with the guests.
          </DialogDescription>
        </DialogHeader>
        {free.length === 0 ? (
          <p className="text-base text-ink">Every other table has guests right now.</p>
        ) : (
          <ul
            className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2"
            aria-label="Free tables"
          >
            {free.map((target) => (
              <li key={target.id}>
                <Button
                  size="touch"
                  variant="outline"
                  className="h-auto min-h-11 w-full py-2 text-lg font-bold break-words whitespace-normal"
                  disabled={move.isPending}
                  onClick={() => moveTo(target)}
                >
                  <span className="sr-only">
                    {tableHeading(target.label) === target.label ? '' : 'Table '}
                  </span>
                  {target.label}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
