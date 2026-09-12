'use client';

import { cn } from 'cn';
import { Download, MoreHorizontal, Pencil, Plus, Printer, QrCode, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useOptimistic, useState, useTransition, type FormEvent } from 'react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/shared/empty-state';
import { DragHandle, SortableItem, SortableList } from '@/components/shared/sortable-list';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

import { createTables, regenerateQr, reorderTables, updateTable } from '../actions';
import { describeLabels, parseTableLabels } from '../labels';
import type { AdminTable } from '../queries';

type TablesManagerProps = {
  tables: AdminTable[];
  /** null = unlimited (spec §14.1). */
  maxTables: number | null;
  isOwner: boolean;
  readOnly: boolean;
};

export function TablesManager({ tables, maxTables, isOwner, readOnly }: TablesManagerProps) {
  const active = tables.filter((table) => table.isActive);
  const inactive = tables.filter((table) => !table.isActive);
  const [ordered, setOrdered] = useOptimistic(active);
  const [, startTransition] = useTransition();
  const [regenerating, setRegenerating] = useState<AdminTable | null>(null);
  const atLimit = maxTables !== null && active.length >= maxTables;

  function reorder(next: AdminTable[]) {
    startTransition(async () => {
      setOrdered(next);
      const result = await reorderTables(next.map((table) => table.id));
      if (!result.ok) toast.error(result.error);
    });
  }

  function setActive(table: AdminTable, isActive: boolean) {
    startTransition(async () => {
      const result = await updateTable(table.id, { isActive });
      if (!result.ok) toast.error(result.error);
      else
        toast.success(isActive ? `Table ${table.label} is active` : `Table ${table.label} is off`);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby="add-tables-heading"
        className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="add-tables-heading" className="text-base font-semibold text-ink">
            Add tables
          </h2>
          <p className="text-sm text-ink-muted tabular-nums">
            {maxTables === null
              ? `${active.length} active ${active.length === 1 ? 'table' : 'tables'}`
              : `${active.length} of ${maxTables} tables on your plan`}
          </p>
        </div>
        {atLimit ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border-l-4 border-status-preparing bg-paper px-3 py-2 text-sm text-ink"
          >
            <p className="flex-1">
              You&apos;re using all {maxTables} tables on your plan. Upgrade to Growth for unlimited
              tables, or turn off a table you no longer use.
            </p>
            {isOwner && (
              <Link
                href="/admin/subscription"
                className="font-medium text-brand underline-offset-4 hover:underline"
              >
                See plans
              </Link>
            )}
          </div>
        ) : (
          <AddTablesForm disabled={readOnly} />
        )}
      </section>

      <section
        aria-labelledby="tables-heading"
        className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="tables-heading" className="text-base font-semibold text-ink">
            Tables
          </h2>
          {active.length > 0 && (
            <Link
              href="/admin/tables/print"
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
            >
              <Printer aria-hidden /> Print QR cards
            </Link>
          )}
        </div>

        {active.length === 0 ? (
          <EmptyState
            icon={QrCode}
            title="No tables yet"
            description="Add tables above to print your QR codes, e.g. 1–10."
          />
        ) : (
          <SortableList
            items={ordered}
            onReorder={reorder}
            getLabel={(table) => `Table ${table.label}`}
            disabled={readOnly}
          >
            {(table) => (
              <SortableItem key={table.id} id={table.id} disabled={readOnly}>
                {(handle) => (
                  <TableRow
                    table={table}
                    readOnly={readOnly}
                    onToggle={(isActive) => setActive(table, isActive)}
                    onRegenerate={() => setRegenerating(table)}
                    handle={
                      <DragHandle
                        label={`Move table ${table.label}`}
                        handle={handle}
                        disabled={readOnly}
                      />
                    }
                  />
                )}
              </SortableItem>
            )}
          </SortableList>
        )}

        {inactive.length > 0 && (
          <details className="rounded-md border border-dashed border-line px-2 py-1.5">
            <summary className="cursor-pointer px-1 py-1 text-sm font-medium text-ink-muted">
              Turned off ({inactive.length})
            </summary>
            <ul className="mt-1 flex flex-col gap-1">
              {inactive.map((table) => (
                <li key={table.id}>
                  <TableRow
                    table={table}
                    readOnly={readOnly}
                    onToggle={(isActive) => setActive(table, isActive)}
                    onRegenerate={() => setRegenerating(table)}
                  />
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <RegenerateDialog table={regenerating} onClose={() => setRegenerating(null)} />
    </div>
  );
}

function AddTablesForm({ disabled }: { disabled: boolean }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const preview = input.trim() ? parseTableLabels(input) : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createTables(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setInput('');
      setError(null);
      toast.success(result.data.count === 1 ? 'Table added' : `${result.data.count} tables added`);
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <label htmlFor="new-tables" className="text-sm font-medium text-ink">
        Table name or range
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="new-tables"
          value={input}
          placeholder="e.g. 5, T5, Terrace 2 or 1–20"
          onChange={(event) => {
            setInput(event.target.value);
            setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby="new-tables-hint"
          disabled={disabled}
          className="h-9 max-w-xs"
        />
        <Button type="submit" size="lg" disabled={disabled || pending || !preview?.ok}>
          <Plus aria-hidden /> Add
        </Button>
      </div>
      <p
        id="new-tables-hint"
        role={error ? 'alert' : undefined}
        className={cn('text-sm', error ? 'text-destructive' : 'text-ink-muted')}
      >
        {error ??
          (preview
            ? preview.ok
              ? describeLabels(preview.labels)
              : preview.error
            : 'Type one name, or a range like 1–20 or T1–T5 to add many at once.')}
      </p>
    </form>
  );
}

function TableRow({
  table,
  readOnly,
  onToggle,
  onRegenerate,
  handle,
}: {
  table: AdminTable;
  readOnly: boolean;
  onToggle: (isActive: boolean) => void;
  onRegenerate: () => void;
  handle?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  function rename(value: string) {
    const label = value.trim();
    if (label === '' || label === table.label) {
      setEditing(false);
      return;
    }
    startTransition(async () => {
      const result = await updateTable(table.id, { label });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setEditing(false);
      toast.success(`Renamed to ${label}`);
    });
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface p-2',
        !table.isActive && 'bg-paper',
      )}
    >
      {handle ?? <span aria-hidden className="w-7 shrink-0" />}
      {editing ? (
        <Input
          aria-label={`Rename table ${table.label}`}
          defaultValue={table.label}
          maxLength={30}
          autoFocus
          disabled={pending}
          className="h-9 w-48"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              rename(event.currentTarget.value);
            } else if (event.key === 'Escape') {
              setEditing(false);
            }
          }}
          onBlur={(event) => rename(event.currentTarget.value)}
        />
      ) : (
        <span className="min-w-16 text-lg font-semibold text-ink tabular-nums">{table.label}</span>
      )}
      <span
        className={cn(
          'rounded-full px-2 py-0.5 text-xs font-medium',
          !table.isActive
            ? 'bg-muted text-ink-muted'
            : table.occupied
              ? 'bg-status-preparing-fill text-status-preparing-foreground'
              : 'bg-muted text-ink',
        )}
      >
        {!table.isActive ? 'Off' : table.occupied ? 'Occupied' : 'Free'}
      </span>

      <div className="ml-auto flex items-center gap-2">
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <Switch
            checked={table.isActive}
            onCheckedChange={onToggle}
            disabled={readOnly}
            aria-label={`Table ${table.label} active`}
          />
          <span aria-hidden className="hidden sm:inline">
            Active
          </span>
        </div>
        <a
          href={`/admin/tables/${table.id}/qr`}
          download
          className={buttonVariants({ variant: 'outline', size: 'lg' })}
          aria-label={`Download QR code for table ${table.label}`}
        >
          <Download aria-hidden /> QR
        </a>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={`More for table ${table.label}`}
                disabled={readOnly}
              />
            }
          >
            <MoreHorizontal aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <Pencil aria-hidden /> Rename
            </DropdownMenuItem>
            {table.isActive && (
              <DropdownMenuItem render={<Link href={`/admin/tables/print?tables=${table.id}`} />}>
                <Printer aria-hidden /> Print this card
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onRegenerate}>
              <RefreshCw aria-hidden /> Regenerate QR code
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function RegenerateDialog({ table, onClose }: { table: AdminTable | null; onClose: () => void }) {
  const [pending, startTransition] = useTransition();

  function confirm() {
    if (!table) return;
    startTransition(async () => {
      const result = await regenerateQr(table.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`New QR code for table ${table.label}. Print and replace the old sticker.`);
      onClose();
    });
  }

  return (
    <AlertDialog open={table !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Regenerate the QR code for table {table?.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            The old sticker stops working straight away. Customers who scan it will see an invalid
            code, so print the new card and replace it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirm} disabled={pending}>
            Regenerate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
