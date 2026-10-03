'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { cn } from 'cn';
import { MoreHorizontal, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { useId, useOptimistic, useState, useTransition } from 'react';
import { Controller, useForm, useWatch, type Path } from 'react-hook-form';
import { toast } from 'sonner';

import { EmptyState } from '@/components/shared/empty-state';
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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

import { deleteWaiter, saveWaiter, setWaiterOnDuty } from '../actions';
import type { WaiterOverview } from '../queries';
import { waiterFormSchema, type WaiterForm } from '../schemas';
import { waiterStatus } from '../status';

/** A waiter login that can be linked to a profile. */
export type WaiterLogin = { memberId: string; displayName: string; username: string };

type WaitersManagerProps = {
  waiters: WaiterOverview[];
  /** Active waiter-role logins not linked to any profile. */
  freeLogins: WaiterLogin[];
  maxTablesPerWaiter: number;
  restaurantSlug: string;
  readOnly: boolean;
};

export function WaitersManager({
  waiters,
  freeLogins,
  maxTablesPerWaiter,
  restaurantSlug,
  readOnly,
}: WaitersManagerProps) {
  const [editing, setEditing] = useState<{ waiter: WaiterOverview | null } | null>(null);
  const [deleting, setDeleting] = useState<WaiterOverview | null>(null);

  return (
    <section
      aria-labelledby="waiters-heading"
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="waiters-heading" className="text-base font-semibold text-ink">
            Waiters
          </h2>
          <p className="text-sm text-ink-muted">
            Only on-duty waiters are offered when a table needs a waiter. A waiter doesn&apos;t need
            a login.
          </p>
        </div>
        <Button size="lg" onClick={() => setEditing({ waiter: null })} disabled={readOnly}>
          <Plus aria-hidden /> Add waiter
        </Button>
      </div>

      {waiters.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No waiters yet"
          description="Add the people who serve tables, so managers can assign them and bills show who served."
        />
      ) : (
        <Table label="Waiters table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>On duty</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Login</TableHead>
              <TableHead className="text-right">Tables today</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {waiters.map((waiter) => (
              <WaiterRow
                key={waiter.id}
                waiter={waiter}
                maxTablesPerWaiter={maxTablesPerWaiter}
                readOnly={readOnly}
                onEdit={() => setEditing({ waiter })}
                onDelete={() => setDeleting(waiter)}
              />
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing?.waiter ? `Edit ${editing.waiter.fullName}` : 'Add waiter'}
            </DialogTitle>
            <DialogDescription>
              Details shown to managers when assigning tables, and on bills and reports.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <WaiterFormBody
              waiter={editing.waiter}
              freeLogins={freeLogins}
              restaurantSlug={restaurantSlug}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <DeleteWaiterDialog waiter={deleting} onClose={() => setDeleting(null)} />
    </section>
  );
}

function WaiterRow({
  waiter,
  maxTablesPerWaiter,
  readOnly,
  onEdit,
  onDelete,
}: {
  waiter: WaiterOverview;
  maxTablesPerWaiter: number;
  readOnly: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [onDuty, setOnDuty] = useOptimistic(waiter.onDuty);
  const [, startTransition] = useTransition();
  const status = waiterStatus({ ...waiter, onDuty }, maxTablesPerWaiter);

  function toggle(next: boolean) {
    startTransition(async () => {
      setOnDuty(next);
      const result = await setWaiterOnDuty(waiter.id, next);
      if (!result.ok) toast.error(result.error);
      else toast.success(next ? `${waiter.fullName} is on duty` : `${waiter.fullName} is off duty`);
    });
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        {waiter.fullName}
        {waiter.notes && <span className="block text-xs text-ink-muted">{waiter.notes}</span>}
      </TableCell>
      <TableCell className="text-sm tabular-nums">{waiter.phone ?? '—'}</TableCell>
      <TableCell className="text-sm">{waiter.employeeCode ?? '—'}</TableCell>
      <TableCell>
        <Switch
          checked={onDuty}
          onCheckedChange={toggle}
          aria-label={`${waiter.fullName} on duty`}
        />
      </TableCell>
      <TableCell>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
            status.tone === 'free' && 'bg-status-served-fill text-status-served-foreground',
            status.tone === 'busy' && 'bg-status-preparing-fill text-status-preparing-foreground',
            status.tone === 'off' && 'bg-muted text-ink-muted',
          )}
        >
          {status.label}
        </span>
      </TableCell>
      <TableCell className="font-mono text-sm">
        {waiter.memberUsername ?? <span className="font-sans text-ink-muted">No login</span>}
        {waiter.memberUsername && waiter.memberActive === false && (
          <span className="block font-sans text-xs text-ink-muted">Deactivated</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{waiter.tablesToday}</TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${waiter.fullName}`}
                disabled={readOnly}
              />
            }
          >
            <MoreHorizontal aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil aria-hidden /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 aria-hidden /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function defaultsFor(waiter: WaiterOverview | null): WaiterForm {
  return {
    id: waiter?.id,
    fullName: waiter?.fullName ?? '',
    phone: waiter?.phone ?? '',
    employeeCode: waiter?.employeeCode ?? '',
    joinedOn: waiter?.joinedOn ?? '',
    notes: waiter?.notes ?? '',
    loginMode: waiter?.memberId ? 'link' : 'none',
    memberId: waiter?.memberId ?? '',
    username: '',
    password: '',
  };
}

function WaiterFormBody({
  waiter,
  freeLogins,
  restaurantSlug,
  onDone,
}: {
  waiter: WaiterOverview | null;
  freeLogins: WaiterLogin[];
  restaurantSlug: string;
  onDone: () => void;
}) {
  const ids = useId();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(waiterFormSchema), defaultValues: defaultsFor(waiter) });
  const loginMode = useWatch({ control, name: 'loginMode' });
  const username = useWatch({ control, name: 'username' });

  // The current link (if any) plus logins nobody else uses.
  const linkable: WaiterLogin[] = [
    ...(waiter?.memberId && waiter.memberUsername
      ? [
          {
            memberId: waiter.memberId,
            displayName: waiter.fullName,
            username: waiter.memberUsername,
          },
        ]
      : []),
    ...freeLogins,
  ];
  const loginItems = linkable.map((login) => ({
    value: login.memberId,
    label: `${login.username} (${login.displayName})`,
  }));

  const onSubmit = handleSubmit(async (values) => {
    const result = await saveWaiter(values);
    if (!result.ok) {
      for (const [key, message] of Object.entries(result.fieldErrors ?? {})) {
        setError(key as Path<WaiterForm>, { message });
      }
      if (!result.fieldErrors) setError('root', { message: result.error });
      return;
    }
    toast.success(waiter ? `Saved ${values.fullName}` : `Added ${values.fullName}`);
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <Field data-invalid={errors.fullName ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-name`}>Full name</FieldLabel>
          <Input id={`${ids}-name`} className="h-9" autoComplete="off" {...register('fullName')} />
          <FieldError errors={[errors.fullName]} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={errors.phone ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-phone`}>Phone (optional)</FieldLabel>
            <Input
              id={`${ids}-phone`}
              type="tel"
              inputMode="tel"
              className="h-9"
              placeholder="98765 43210"
              {...register('phone')}
            />
            <FieldError errors={[errors.phone]} />
          </Field>
          <Field data-invalid={errors.employeeCode ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-code`}>Employee code (optional)</FieldLabel>
            <Input id={`${ids}-code`} className="h-9" {...register('employeeCode')} />
            <FieldError errors={[errors.employeeCode]} />
          </Field>
        </div>
        <Field data-invalid={errors.joinedOn ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-joined`}>Joined on (optional)</FieldLabel>
          <Input id={`${ids}-joined`} type="date" className="h-9 w-48" {...register('joinedOn')} />
          <FieldError errors={[errors.joinedOn]} />
        </Field>
        <Field data-invalid={errors.notes ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-notes`}>Notes (optional)</FieldLabel>
          <Textarea
            id={`${ids}-notes`}
            rows={2}
            maxLength={300}
            placeholder="e.g. Evening shift, off on Tuesdays"
            {...register('notes')}
          />
          <FieldError errors={[errors.notes]} />
        </Field>

        <fieldset className="flex flex-col gap-3 rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-medium text-ink">Login</legend>
          <Controller
            control={control}
            name="loginMode"
            render={({ field }) => (
              <RadioGroup
                aria-label="Login"
                value={field.value}
                onValueChange={(value) => field.onChange(value)}
                className="gap-2"
              >
                <label className="flex items-center gap-2 text-sm text-ink">
                  <RadioGroupItem value="none" /> No login (shared tablet)
                </label>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <RadioGroupItem value="link" disabled={linkable.length === 0} /> Link an existing
                  waiter login
                  {linkable.length === 0 && (
                    <span className="text-xs text-ink-muted">(none available)</span>
                  )}
                </label>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <RadioGroupItem value="create" /> Create a login for this waiter
                </label>
              </RadioGroup>
            )}
          />
          <FieldDescription>
            With a login, the waiter gets a &ldquo;My tables&rdquo; view and is assigned
            automatically when they order for a table.
          </FieldDescription>

          {loginMode === 'link' && (
            <Field data-invalid={errors.memberId ? true : undefined}>
              <FieldLabel htmlFor={`${ids}-login`}>Waiter login</FieldLabel>
              <Controller
                control={control}
                name="memberId"
                render={({ field }) => (
                  <Select
                    items={loginItems}
                    value={field.value || null}
                    onValueChange={(value) => field.onChange(value ?? '')}
                  >
                    <SelectTrigger id={`${ids}-login`} className="h-9 w-full">
                      <SelectValue placeholder="Choose a login" />
                    </SelectTrigger>
                    <SelectContent>
                      {loginItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldError errors={[errors.memberId]} />
            </Field>
          )}

          {loginMode === 'create' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={errors.username ? true : undefined}>
                <FieldLabel htmlFor={`${ids}-username`}>Username</FieldLabel>
                <Input
                  id={`${ids}-username`}
                  className="h-9 font-mono"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  {...register('username')}
                />
                <FieldDescription>
                  Logs in as {restaurantSlug} / {username?.trim().toLowerCase() || 'username'}
                </FieldDescription>
                <FieldError errors={[errors.username]} />
              </Field>
              <Field data-invalid={errors.password ? true : undefined}>
                <FieldLabel htmlFor={`${ids}-password`}>Password</FieldLabel>
                <Input
                  id={`${ids}-password`}
                  type="password"
                  className="h-9"
                  autoComplete="new-password"
                  {...register('password')}
                />
                <FieldDescription>At least 8 characters.</FieldDescription>
                <FieldError errors={[errors.password]} />
              </Field>
            </div>
          )}
        </fieldset>
      </FieldGroup>

      {errors.root?.message && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errors.root.message}
        </p>
      )}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" size="lg" />}>
          Cancel
        </DialogClose>
        <Button type="submit" size="lg" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : waiter ? 'Save waiter' : 'Add waiter'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteWaiterDialog({
  waiter,
  onClose,
}: {
  waiter: WaiterOverview | null;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function confirm() {
    if (!waiter) return;
    startTransition(async () => {
      const result = await deleteWaiter(waiter.id);
      if (!result.ok) {
        toast.error(result.error);
        onClose();
        return;
      }
      toast.success(`Deleted ${waiter.fullName}`);
      onClose();
    });
  }

  return (
    <AlertDialog open={waiter !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {waiter?.fullName}?</AlertDialogTitle>
          <AlertDialogDescription>
            They won&apos;t be offered for tables any more. Past bills and reports keep their name.
            {waiter?.memberUsername &&
              ` Their login ${waiter.memberUsername} stays under Staff logins, unlinked.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirm} disabled={pending}>
            Delete waiter
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
