'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { cn } from 'cn';
import { Copy, History, Link2, MoreHorizontal, Pencil, Plus, UserCheck, UserX } from 'lucide-react';
import Link from 'next/link';
import { useId, useState, useTransition } from 'react';
import { useForm, useWatch } from 'react-hook-form';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { formatDateTime } from '../platform';
import {
  DIGEST_ROLES,
  INVITE_DAYS,
  inviteSchema,
  memberStatus,
  TEAM_ROLE_DESCRIPTIONS,
  TEAM_ROLE_LABELS,
  TEAM_ROLES,
  type InviteInput,
  type TeamListRow,
  type TeamRole,
} from '../team';
import {
  inviteMember,
  renewInvite,
  setMemberDisabled,
  updateMember,
  type InviteSent,
} from '../team-actions';

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm';

type Dialogs =
  | { kind: 'invite' }
  | { kind: 'sent'; sent: InviteSent }
  | { kind: 'edit'; member: TeamListRow }
  | { kind: 'off'; member: TeamListRow }
  | null;

const nameOf = (member: TeamListRow) => member.display_name ?? member.email ?? 'Team member';

/**
 * The team (docs/SUPER_ADMIN_PLAN.md 13g, docs/DECISIONS.md SA-70+): who is
 * on it, their role, and inviting, changing and turning members off.
 */
export function TeamManager({ members }: { members: TeamListRow[] }) {
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [pending, startTransition] = useTransition();
  const close = () => setDialog(null);

  function renew(member: TeamListRow) {
    startTransition(async () => {
      const result = await renewInvite(member.user_id);
      if (result.ok) setDialog({ kind: 'sent', sent: result.data });
      else toast.error(result.error);
    });
  }

  function turnOn(member: TeamListRow) {
    startTransition(async () => {
      const result = await setMemberDisabled(member.user_id, false);
      if (result.ok) toast.success(`${nameOf(member)} is back on the team`);
      else toast.error(result.error);
    });
  }

  return (
    <>
      <div className="flex justify-end">
        <Button size="touch" onClick={() => setDialog({ kind: 'invite' })}>
          <Plus aria-hidden />
          Invite a team member
        </Button>
      </div>

      <Table label="Team members">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Second factor</TableHead>
            <TableHead>Last sign-in</TableHead>
            <TableHead>Daily digest</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => {
            const status = memberStatus(member);
            return (
              <TableRow
                key={member.user_id}
                data-email={member.email}
                className={cn(status === 'off' && 'text-ink-muted')}
              >
                <TableCell className="max-w-64 whitespace-normal">
                  <span className="font-medium">{nameOf(member)}</span>
                  {member.is_you && <span className="ml-1 text-xs text-ink-muted">(you)</span>}
                  {member.display_name && member.email && (
                    <span className="block text-xs [overflow-wrap:anywhere] text-ink-muted">
                      {member.email}
                    </span>
                  )}
                  {member.invited_by && (
                    <span className="block text-xs text-ink-muted">
                      Invited by {member.invited_by}
                    </span>
                  )}
                </TableCell>
                <TableCell>{TEAM_ROLE_LABELS[member.role]}</TableCell>
                <TableCell>
                  {status === 'active' && 'Active'}
                  {status === 'off' && `Off since ${formatDateTime(member.disabled_at)}`}
                  {status === 'invited' &&
                    (member.invite_expires_at && new Date(member.invite_expires_at) > new Date()
                      ? `Invited, link works until ${formatDateTime(member.invite_expires_at)}`
                      : 'Invited, the link has expired')}
                </TableCell>
                <TableCell>{member.second_factor ? 'Set up' : 'Not yet'}</TableCell>
                <TableCell className="text-sm tabular-nums">
                  {member.last_sign_in_at ? formatDateTime(member.last_sign_in_at) : 'Never'}
                </TableCell>
                <TableCell>
                  {DIGEST_ROLES.includes(member.role) ? (member.digest ? 'On' : 'Off') : '—'}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-touch"
                          aria-label={`Actions for ${nameOf(member)}`}
                          disabled={pending}
                        />
                      }
                    >
                      <MoreHorizontal aria-hidden />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      {status !== 'off' && (
                        <DropdownMenuItem onClick={() => setDialog({ kind: 'edit', member })}>
                          <Pencil aria-hidden /> Change role or name
                        </DropdownMenuItem>
                      )}
                      {status === 'invited' && (
                        <DropdownMenuItem onClick={() => renew(member)}>
                          <Link2 aria-hidden /> New invite link
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        render={<Link href={`/super/audit?member=${member.user_id}`} />}
                      >
                        <History aria-hidden /> What they did
                      </DropdownMenuItem>
                      {status === 'off' ? (
                        <DropdownMenuItem onClick={() => turnOn(member)}>
                          <UserCheck aria-hidden /> Turn back on
                        </DropdownMenuItem>
                      ) : (
                        !member.is_you && (
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setDialog({ kind: 'off', member })}
                          >
                            <UserX aria-hidden /> Turn off
                          </DropdownMenuItem>
                        )
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <Dialog open={dialog?.kind === 'invite'} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite a team member</DialogTitle>
            <DialogDescription>
              They choose a password from the link, then set up an authenticator app.
            </DialogDescription>
          </DialogHeader>
          {dialog?.kind === 'invite' && (
            <InviteForm onSent={(sent) => setDialog({ kind: 'sent', sent })} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={dialog?.kind === 'sent'} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite ready</DialogTitle>
            <DialogDescription>
              {dialog?.kind === 'sent' && dialog.sent.emailed
                ? `We’re emailing the link to ${dialog.sent.email}. You can also send it yourself.`
                : `Email isn’t set up, so send this link to ${dialog?.kind === 'sent' ? dialog.sent.email : 'them'} yourself.`}{' '}
              It works for {INVITE_DAYS} days, once.
            </DialogDescription>
          </DialogHeader>
          {dialog?.kind === 'sent' && <CopyLink link={dialog.sent.link} />}
          <DialogFooter>
            <Button size="touch" onClick={close}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog?.kind === 'edit'} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === 'edit' ? `Change ${nameOf(dialog.member)}` : 'Change'}
            </DialogTitle>
            <DialogDescription>
              Their role decides what they can open, from their next page.
            </DialogDescription>
          </DialogHeader>
          {dialog?.kind === 'edit' && <EditForm member={dialog.member} onDone={close} />}
        </DialogContent>
      </Dialog>

      <AlertDialog open={dialog?.kind === 'off'} onOpenChange={(open) => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Turn off {dialog?.kind === 'off' ? nameOf(dialog.member) : ''}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They’re signed out of the team panel at once and can’t sign in again, until an Admin
              turns them back on. Their history stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (dialog?.kind !== 'off') return;
                const { member } = dialog;
                startTransition(async () => {
                  const result = await setMemberDisabled(member.user_id, true);
                  if (result.ok) {
                    toast.success(`${nameOf(member)} is off the team`);
                    close();
                  } else toast.error(result.error);
                });
              }}
            >
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function RoleField({
  id,
  register,
  role,
  error,
}: {
  id: string;
  register: ReturnType<typeof useForm<InviteInput>>['register'];
  role: TeamRole | undefined;
  error?: { message?: string };
}) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>Role</FieldLabel>
      <select id={id} className={SELECT_CLASS} {...register('role')}>
        {TEAM_ROLES.map((value) => (
          <option key={value} value={value}>
            {TEAM_ROLE_LABELS[value]}
          </option>
        ))}
      </select>
      {role && <FieldDescription>{TEAM_ROLE_DESCRIPTIONS[role]}</FieldDescription>}
      <FieldError errors={[error]} />
    </Field>
  );
}

function InviteForm({ onSent }: { onSent: (sent: InviteSent) => void }) {
  const ids = useId();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<InviteInput>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', displayName: '', role: 'support' },
  });
  const role = useWatch({ control, name: 'role' });

  const onSubmit = handleSubmit(async (values) => {
    const result = await inviteMember(values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        setError(field as keyof InviteInput, { message });
      }
      if (!result.fieldErrors) setError('root', { message: result.error });
      return;
    }
    onSent(result.data);
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <Field data-invalid={errors.email ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-email`}>Email</FieldLabel>
          <Input
            id={`${ids}-email`}
            type="email"
            autoComplete="off"
            className="h-11 md:h-9"
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? `${ids}-email-error` : undefined}
            {...register('email')}
          />
          <FieldError id={`${ids}-email-error`} errors={[errors.email]} />
        </Field>
        <Field data-invalid={errors.displayName ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
          <Input
            id={`${ids}-name`}
            autoComplete="off"
            className="h-11 md:h-9"
            aria-invalid={errors.displayName ? true : undefined}
            aria-describedby={errors.displayName ? `${ids}-name-error` : undefined}
            {...register('displayName')}
          />
          <FieldError id={`${ids}-name-error`} errors={[errors.displayName]} />
        </Field>
        <RoleField id={`${ids}-role`} register={register} role={role} error={errors.role} />
      </FieldGroup>
      {errors.root && (
        <p role="alert" className="text-sm text-destructive">
          {errors.root.message}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" size="touch" disabled={isSubmitting}>
          {isSubmitting ? 'Inviting…' : 'Invite'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditForm({ member, onDone }: { member: TeamListRow; onDone: () => void }) {
  const ids = useId();
  const [name, setName] = useState(member.display_name ?? '');
  const [role, setRole] = useState<TeamRole>(member.role);
  const [digest, setDigest] = useState(member.digest);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const digestRole = DIGEST_ROLES.includes(role);

  function save(event: React.FormEvent) {
    event.preventDefault();
    const patch = {
      ...(role !== member.role && { role }),
      ...(name.trim() !== (member.display_name ?? '') && { displayName: name }),
      ...(digestRole && digest !== member.digest && { digest }),
    };
    if (Object.keys(patch).length === 0) return onDone();
    startTransition(async () => {
      const result = await updateMember(member.user_id, patch);
      if (result.ok) {
        toast.success(`Saved ${name.trim() || nameOf(member)}`);
        onDone();
      } else setError(result.fieldErrors ? 'Check the name and try again.' : result.error);
    });
  }

  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
          <Input
            id={`${ids}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-11 md:h-9"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-role`}>Role</FieldLabel>
          <select
            id={`${ids}-role`}
            className={SELECT_CLASS}
            value={role}
            onChange={(event) => setRole(event.target.value as TeamRole)}
          >
            {TEAM_ROLES.map((value) => (
              <option key={value} value={value}>
                {TEAM_ROLE_LABELS[value]}
              </option>
            ))}
          </select>
          <FieldDescription>{TEAM_ROLE_DESCRIPTIONS[role]}</FieldDescription>
        </Field>
        {digestRole && (
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink md:min-h-9">
            <input
              type="checkbox"
              checked={digest}
              onChange={(event) => setDigest(event.target.checked)}
              className="size-4 accent-brand"
            />
            Daily digest email (MRR, money collected and what needs attention)
          </label>
        )}
      </FieldGroup>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" size="touch" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CopyLink({ link }: { link: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        Invite link
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          readOnly
          value={link}
          className="h-11 font-mono text-xs md:h-9"
          onFocus={(event) => event.target.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="touch"
          onClick={() =>
            navigator.clipboard
              .writeText(link)
              .then(() => toast.success('Link copied'))
              .catch(() => toast.error('Couldn’t copy: select the link and copy it'))
          }
        >
          <Copy aria-hidden />
          Copy
        </Button>
      </div>
    </div>
  );
}
