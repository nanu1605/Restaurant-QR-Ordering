'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BOARD_MUTATION_KEY } from '@/features/live/query-client';
import { listNames, tableHeading } from '@/features/ordering/format';
import type { Board } from '@/features/orders/board';
import { type WaiterAvailability, waiterAvailability } from '@/features/orders/board-view';
import { waiterStatus } from '@/features/waiters/status';

import { assignWaiter, type AssignWaiterResult } from '../actions';

type AssignWaiterDialogProps = {
  board: Board;
  sessionId: string | null;
  tableLabel: string;
  currentWaiterId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Assign or reassign a table's waiter (spec §10.7): available waiters first,
 * busy ones greyed with the tables they're handling and a confirmation before
 * giving them another. Off-duty and deleted waiters aren't offered.
 */
export function AssignWaiterDialog({
  open,
  onOpenChange,
  sessionId,
  ...props
}: AssignWaiterDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        {open && sessionId && (
          <Picker {...props} sessionId={sessionId} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

type PickerProps = Omit<AssignWaiterDialogProps, 'open' | 'onOpenChange' | 'sessionId'> & {
  sessionId: string;
  onDone: () => void;
};

function Picker({ board, sessionId, tableLabel, currentWaiterId, onDone }: PickerProps) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<{
    waiter: WaiterAvailability;
    tables: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heading = tableHeading(tableLabel);

  const assign = useMutation({
    mutationKey: BOARD_MUTATION_KEY,
    mutationFn: ({
      waiterId,
      force,
    }: {
      waiterId: string;
      force: boolean;
    }): Promise<AssignWaiterResult> => assignWaiter(sessionId, waiterId, force),
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: BOARD_MUTATION_KEY }) === 1) {
        void queryClient.invalidateQueries({ queryKey: ['board'] });
      }
      // The bill builder shows the waiter too.
      void queryClient.invalidateQueries({ queryKey: ['billing'] });
    },
  });

  async function choose(waiter: WaiterAvailability, force: boolean) {
    setError(null);
    let result: AssignWaiterResult;
    try {
      result = await assign.mutateAsync({ waiterId: waiter.id, force });
    } catch {
      setError('Couldn’t reach the server. Check the connection and try again.');
      return;
    }
    if (!result.ok) {
      // Someone else gave them their last free table meanwhile.
      if (result.busyTables?.length) setConfirming({ waiter, tables: result.busyTables });
      else setError(result.error);
      return;
    }
    const approved = result.data.approvedOrders;
    toast.success(`${waiter.name} is now the waiter for ${heading}`, {
      description:
        approved === 1
          ? 'The waiting order was approved.'
          : approved > 1
            ? `${approved} waiting orders were approved.`
            : undefined,
    });
    onDone();
  }

  const onDuty = waiterAvailability(board).filter((waiter) => waiter.status !== 'off_duty');
  const available = onDuty.filter((waiter) => waiter.status === 'available');
  const busy = onDuty.filter((waiter) => waiter.status === 'busy');

  if (confirming) {
    const tables = listNames(confirming.tables.map(tableHeading));
    return (
      <>
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-ink">
            Assign a busy waiter?
          </DialogTitle>
          <DialogDescription className="text-base text-ink">
            {confirming.waiter.name} is already handling {tables}. Assign anyway?
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm font-medium text-status-void">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            size="touch"
            onClick={() => setConfirming(null)}
            disabled={assign.isPending}
          >
            Back
          </Button>
          <Button
            size="touch"
            onClick={() => void choose(confirming.waiter, true)}
            disabled={assign.isPending}
          >
            Assign anyway
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-lg font-semibold text-ink">
          {currentWaiterId ? 'Reassign' : 'Assign a waiter to'} {heading}
        </DialogTitle>
        <DialogDescription>Available waiters are listed first.</DialogDescription>
      </DialogHeader>

      {onDuty.length === 0 ? (
        <p className="text-base text-ink">
          No waiters on duty.{' '}
          <Link
            href="/admin/waiters"
            className="font-medium text-brand underline underline-offset-4"
          >
            Switch someone on duty in Waiters
          </Link>
          .
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {[
            { title: 'Available', waiters: available },
            { title: 'Busy', waiters: busy },
          ]
            .filter((group) => group.waiters.length > 0)
            .map((group) => (
              <section key={group.title} aria-label={group.title} className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-ink-muted">{group.title}</h3>
                <ul className="flex flex-col gap-2">
                  {group.waiters.map((waiter) => {
                    const current = waiter.id === currentWaiterId;
                    const status = waiterStatus(
                      { onDuty: waiter.onDuty, openTables: waiter.tables },
                      board.settings.maxTablesPerWaiter,
                    );
                    return (
                      <li key={waiter.id}>
                        <Button
                          variant="outline"
                          size="touch"
                          disabled={current || assign.isPending}
                          onClick={() =>
                            waiter.status === 'busy'
                              ? setConfirming({ waiter, tables: waiter.tables })
                              : void choose(waiter, false)
                          }
                          className={
                            waiter.status === 'busy'
                              ? 'h-auto min-h-11 w-full justify-between py-2 text-ink-muted'
                              : 'h-auto min-h-11 w-full justify-between py-2'
                          }
                        >
                          <span className="font-semibold">{waiter.name}</span>
                          <span className="text-sm font-normal">
                            {current ? 'Current' : status.label}
                          </span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm font-medium text-status-void">
          {error}
        </p>
      )}
    </>
  );
}
