'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { cn } from 'cn';
import { KeyRound, MoreHorizontal, Pencil, Plus, UserCheck, UserX } from 'lucide-react';
import { useId, useState, useTransition } from 'react';
import {
  Controller,
  useForm,
  useWatch,
  type FieldValues,
  type Path,
  type UseFormSetError,
} from 'react-hook-form';
import { toast } from 'sonner';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { LANG_NAMES } from '@/features/ordering/strings';
import { assignableRoles, canManageRole, ROLE_LABELS, type MemberRole } from '@/lib/auth/roles';
import { DEFAULT_LOCALE } from '@/lib/config';

import { createStaff, resetStaffPassword, setStaffActive, updateStaff } from '../actions';
import type { StaffMember } from '../queries';
import {
  editStaffSchema,
  newStaffSchema,
  resetPasswordSchema,
  type EditStaff,
  type NewStaff,
  type ResetPassword,
} from '../schemas';

type StaffManagerProps = {
  staff: StaffMember[];
  actorRole: MemberRole;
  actorMemberId: string;
  /** Staff logins allowed besides the owner; null = unlimited. */
  maxStaff: number | null;
  restaurantSlug: string;
  loginUrl: string;
  timezone: string;
  readOnly: boolean;
};

type OpenDialog =
  | { kind: 'add' }
  | { kind: 'edit'; member: StaffMember }
  | { kind: 'password'; member: StaffMember }
  | { kind: 'deactivate'; member: StaffMember }
  | null;

function applyFieldErrors<T extends FieldValues>(
  setError: UseFormSetError<T>,
  fieldErrors: Record<string, string> | undefined,
) {
  for (const [key, message] of Object.entries(fieldErrors ?? {})) {
    setError(key as Path<T>, { message });
  }
}

export function StaffManager({
  staff,
  actorRole,
  actorMemberId,
  maxStaff,
  restaurantSlug,
  loginUrl,
  timezone,
  readOnly,
}: StaffManagerProps) {
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [, startTransition] = useTransition();
  const staffCount = staff.filter((member) => member.isActive && member.role !== 'owner').length;
  const atLimit = maxStaff !== null && staffCount >= maxStaff;
  const formatLastLogin = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  });

  function reactivate(member: StaffMember) {
    startTransition(async () => {
      const result = await setStaffActive(member.memberId, true);
      if (!result.ok) toast.error(result.error);
      else toast.success(`${member.displayName} can log in again`);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby="staff-heading"
        className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 id="staff-heading" className="text-base font-semibold text-ink">
              Logins
            </h2>
            <p className="text-sm text-ink-muted">
              Staff log in at {loginUrl} with restaurant code{' '}
              <span className="font-semibold text-ink">{restaurantSlug}</span> and their username.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-ink-muted tabular-nums">
              {maxStaff === null
                ? `${staffCount} staff ${staffCount === 1 ? 'login' : 'logins'}`
                : `${staffCount} of ${maxStaff} staff logins`}
            </span>
            <Button
              size="lg"
              onClick={() => setDialog({ kind: 'add' })}
              disabled={readOnly || atLimit}
            >
              <Plus aria-hidden /> Add staff
            </Button>
          </div>
        </div>
        {atLimit && (
          <p
            role="status"
            className="rounded-md border-l-4 border-status-preparing bg-paper px-3 py-2 text-sm text-ink"
          >
            You&apos;re using all {maxStaff} staff logins on your plan. Deactivate one you no longer
            need, or upgrade for more. The owner&apos;s login doesn&apos;t count.
          </p>
        )}

        <Table label="Staff logins">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last login</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {staff.map((member) => {
              const isSelf = member.memberId === actorMemberId;
              const canManage = !isSelf && canManageRole(actorRole, member.role);
              return (
                <TableRow
                  key={member.memberId}
                  className={cn(!member.isActive && 'text-ink-muted')}
                >
                  <TableCell className="font-medium">
                    {member.displayName}
                    {isSelf && <span className="ml-1 text-xs text-ink-muted">(you)</span>}
                    {member.waiterName && (
                      <span className="block text-xs text-ink-muted">
                        Waiter profile: {member.waiterName}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-sm">{member.username}</TableCell>
                  <TableCell>
                    {ROLE_LABELS[member.role]}
                    {member.uiLang === 'hi' && (
                      <span
                        title="Worker panel in Hindi"
                        className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-ink"
                      >
                        <span lang="hi">{LANG_NAMES.hi}</span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-medium',
                        member.isActive ? 'bg-muted text-ink' : 'bg-paper text-ink-muted',
                      )}
                    >
                      {member.isActive ? 'Active' : 'Deactivated'}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {member.lastSignInAt
                      ? formatLastLogin.format(new Date(member.lastSignInAt))
                      : 'Never'}
                  </TableCell>
                  <TableCell>
                    {(canManage || isSelf) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Actions for ${member.displayName}`}
                            />
                          }
                        >
                          <MoreHorizontal aria-hidden />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          {canManage && member.isActive && (
                            <DropdownMenuItem
                              onClick={() => setDialog({ kind: 'edit', member })}
                              disabled={readOnly}
                            >
                              <Pencil aria-hidden /> Edit
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => setDialog({ kind: 'password', member })}>
                            <KeyRound aria-hidden /> Reset password
                          </DropdownMenuItem>
                          {canManage &&
                            (member.isActive ? (
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDialog({ kind: 'deactivate', member })}
                              >
                                <UserX aria-hidden /> Deactivate
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onClick={() => reactivate(member)}
                                disabled={readOnly}
                              >
                                <UserCheck aria-hidden /> Reactivate
                              </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <Dialog open={dialog?.kind === 'add'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add staff</DialogTitle>
            <DialogDescription>
              They log in with restaurant code {restaurantSlug}, the username and password you set
              here.
            </DialogDescription>
          </DialogHeader>
          {dialog?.kind === 'add' && (
            <AddStaffForm
              roles={assignableRoles(actorRole)}
              restaurantSlug={restaurantSlug}
              onDone={() => setDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={dialog?.kind === 'edit'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Edit {dialog?.kind === 'edit' ? dialog.member.displayName : 'login'}
            </DialogTitle>
          </DialogHeader>
          {dialog?.kind === 'edit' && (
            <EditStaffForm
              member={dialog.member}
              roles={assignableRoles(actorRole)}
              onDone={() => setDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={dialog?.kind === 'password'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Reset password for {dialog?.kind === 'password' ? dialog.member.displayName : ''}
            </DialogTitle>
            <DialogDescription>
              Tell them the new password. Their current password stops working.
            </DialogDescription>
          </DialogHeader>
          {dialog?.kind === 'password' && (
            <ResetPasswordForm member={dialog.member} onDone={() => setDialog(null)} />
          )}
        </DialogContent>
      </Dialog>

      <DeactivateDialog
        member={dialog?.kind === 'deactivate' ? dialog.member : null}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}

function RoleSelect({
  id,
  roles,
  value,
  onChange,
  invalid,
}: {
  id: string;
  roles: MemberRole[];
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  const items = roles.map((role) => ({ value: role, label: ROLE_LABELS[role] }));
  return (
    <Select items={items} value={value || null} onValueChange={(next) => onChange(next ?? '')}>
      <SelectTrigger id={id} className="h-9 w-full" aria-invalid={invalid || undefined}>
        <SelectValue placeholder="Choose a role" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The worker panel's languages, each by its own name (docs/DECISIONS.md P11-15). */
const LANGUAGE_ITEMS = (['en', 'hi'] as const).map((value) => ({
  value,
  label: LANG_NAMES[value],
}));

const ROLE_HINTS: Record<string, string> = {
  manager: 'Managers use the admin panel: menu, tables, billing, waiters and settings.',
  waiter: 'Waiters approve orders and serve tables in the worker panel.',
  kitchen: 'Kitchen staff see orders and mark dishes preparing and ready.',
};

function AddStaffForm({
  roles,
  restaurantSlug,
  onDone,
}: {
  roles: MemberRole[];
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
  } = useForm({
    resolver: zodResolver(newStaffSchema),
    defaultValues: { displayName: '', username: '', role: 'waiter', password: '' } as NewStaff,
  });
  const role = useWatch({ control, name: 'role' });
  const username = useWatch({ control, name: 'username' });

  const onSubmit = handleSubmit(async (values) => {
    const result = await createStaff(values);
    if (!result.ok) {
      applyFieldErrors(setError, result.fieldErrors);
      if (!result.fieldErrors) setError('root', { message: result.error });
      return;
    }
    toast.success(`${values.displayName} can now log in as ${values.username}`);
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <Field data-invalid={errors.displayName ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
          <Input
            id={`${ids}-name`}
            className="h-9"
            autoComplete="off"
            {...register('displayName')}
          />
          <FieldError errors={[errors.displayName]} />
        </Field>
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
        <Field data-invalid={errors.role ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-role`}>Role</FieldLabel>
          <Controller
            control={control}
            name="role"
            render={({ field }) => (
              <RoleSelect
                id={`${ids}-role`}
                roles={roles}
                value={field.value}
                onChange={field.onChange}
                invalid={Boolean(errors.role)}
              />
            )}
          />
          {role && <FieldDescription>{ROLE_HINTS[role]}</FieldDescription>}
          <FieldError errors={[errors.role]} />
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
          {isSubmitting ? 'Adding…' : 'Add staff'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditStaffForm({
  member,
  roles,
  onDone,
}: {
  member: StaffMember;
  roles: MemberRole[];
  onDone: () => void;
}) {
  const ids = useId();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm({
    resolver: zodResolver(editStaffSchema),
    defaultValues: {
      displayName: member.displayName,
      role: member.role,
      uiLang: member.uiLang,
    } as EditStaff,
  });

  const onSubmit = handleSubmit(async (values) => {
    const result = await updateStaff(member.memberId, {
      ...values,
      // The login may have changed its own since this page loaded (P11-15).
      uiLang: dirtyFields.uiLang ? values.uiLang : undefined,
    });
    if (!result.ok) {
      applyFieldErrors(setError, result.fieldErrors);
      if (!result.fieldErrors) setError('root', { message: result.error });
      return;
    }
    toast.success(`Saved ${values.displayName}`);
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <Field data-invalid={errors.displayName ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
          <Input id={`${ids}-name`} className="h-9" {...register('displayName')} />
          <FieldError errors={[errors.displayName]} />
        </Field>
        <Field data-invalid={errors.role ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-role`}>Role</FieldLabel>
          <Controller
            control={control}
            name="role"
            render={({ field }) => (
              <RoleSelect
                id={`${ids}-role`}
                roles={roles}
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
          {member.waiterName && (
            <FieldDescription>
              Changing the role away from waiter unlinks the waiter profile {member.waiterName}.
            </FieldDescription>
          )}
          <FieldError errors={[errors.role]} />
        </Field>
        <Field data-invalid={errors.uiLang ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-lang`}>Panel language</FieldLabel>
          <Controller
            control={control}
            name="uiLang"
            render={({ field }) => (
              <Select
                items={LANGUAGE_ITEMS}
                value={field.value}
                onValueChange={(next) => field.onChange(next ?? 'en')}
              >
                <SelectTrigger
                  id={`${ids}-lang`}
                  className="h-9 w-full"
                  aria-describedby={`${ids}-lang-hint`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value} lang={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <FieldDescription id={`${ids}-lang-hint`}>
            The worker panel only. The login can also change it from its account menu.
          </FieldDescription>
          <FieldError errors={[errors.uiLang]} />
        </Field>
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
          {isSubmitting ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ResetPasswordForm({ member, onDone }: { member: StaffMember; onDone: () => void }) {
  const ids = useId();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '' } as ResetPassword,
  });

  const onSubmit = handleSubmit(async (values) => {
    const result = await resetStaffPassword(member.memberId, values);
    if (!result.ok) {
      applyFieldErrors(setError, result.fieldErrors);
      if (!result.fieldErrors) setError('root', { message: result.error });
      return;
    }
    toast.success(`New password set for ${member.displayName}`);
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <Field data-invalid={errors.password ? true : undefined}>
        <FieldLabel htmlFor={`${ids}-password`}>New password</FieldLabel>
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
          {isSubmitting ? 'Saving…' : 'Set password'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeactivateDialog({
  member,
  onClose,
}: {
  member: StaffMember | null;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function confirm() {
    if (!member) return;
    startTransition(async () => {
      const result = await setStaffActive(member.memberId, false);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${member.displayName} can no longer log in`);
      onClose();
    });
  }

  return (
    <AlertDialog open={member !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Deactivate {member?.displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            They can&apos;t log in or see this restaurant any more, including on devices where
            they&apos;re already logged in. Their name stays on past orders and bills. You can
            reactivate the login later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirm} disabled={pending}>
            Deactivate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
