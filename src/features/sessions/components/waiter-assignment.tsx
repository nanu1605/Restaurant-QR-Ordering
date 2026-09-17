'use client';

import { useState } from 'react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { tableHeading } from '@/features/ordering/format';
import type { Board, BoardTable } from '@/features/orders/board';
import { waiterName } from '@/features/orders/board-view';
import { useBoardAction } from '@/features/orders/use-board';

import { unassignWaiter } from '../actions';
import { AssignWaiterDialog } from './assign-waiter-dialog';

/** The table drawer's waiter line for managers: Assign / Reassign / Unassign (spec §13.3). */
export function WaiterAssignment({ board, table }: { board: Board; table: BoardTable }) {
  const [assigning, setAssigning] = useState(false);
  const [unassigning, setUnassigning] = useState(false);
  const heading = tableHeading(table.label);
  const unassign = useBoardAction({
    action: (sessionId: string) => unassignWaiter(sessionId),
    successMessage: () => `${heading} is unassigned`,
  });

  const session = table.session;
  if (!session) return null;
  const name = waiterName(board, session.assignedWaiterId);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="mr-auto text-sm text-ink">
        Waiter:{' '}
        {name ? (
          <span className="font-semibold">{name}</span>
        ) : (
          <span className="font-semibold text-attention">Unassigned</span>
        )}
      </p>
      <Button
        size="touch"
        variant={name ? 'outline' : 'default'}
        onClick={() => setAssigning(true)}
      >
        {name ? 'Reassign' : 'Assign waiter'}
      </Button>
      {name && (
        <Button size="touch" variant="ghost" onClick={() => setUnassigning(true)}>
          Unassign
        </Button>
      )}

      <AssignWaiterDialog
        board={board}
        sessionId={session.id}
        tableLabel={table.label}
        currentWaiterId={session.assignedWaiterId}
        open={assigning}
        onOpenChange={setAssigning}
      />

      <AlertDialog open={unassigning} onOpenChange={setUnassigning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Unassign {name} from {heading}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The table goes back to the Unassigned queue. A waiter is needed before billing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="touch">Cancel</AlertDialogCancel>
            <Button
              size="touch"
              onClick={() => {
                unassign.mutate(session.id);
                setUnassigning(false);
              }}
            >
              Unassign
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
