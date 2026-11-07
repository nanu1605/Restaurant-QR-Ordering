'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Ban, MoreHorizontal, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import {
  useForm,
  useWatch,
  type FieldError as FormFieldError,
  type UseFormRegisterReturn,
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
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { searchPlatform } from '@/features/platform/actions';
import { formatDateTime } from '@/features/platform/platform';

import { endAnnouncement, saveAnnouncement } from '../actions';
import {
  announcementForm,
  announcementSchema,
  announcementStatus,
  AUDIENCE_LABELS,
  AUDIENCES,
  audienceLabel,
  PANEL_LABELS,
  PANELS,
  type AnnouncementInput,
  type AnnouncementRow,
} from '../announcements';
import { AnnouncementBanner } from './announcement-banner';

const STATUS_LABELS = { live: 'Live', scheduled: 'Starts later', ended: 'Ended' } as const;
const CHECK_LABEL = 'flex min-h-11 items-center gap-2 text-sm md:min-h-0';

type Plan = { code: string; name: string; active: boolean };
type Dialogs =
  | { kind: 'new' }
  | { kind: 'edit'; row: AnnouncementRow }
  | { kind: 'end'; row: AnnouncementRow }
  | null;

/**
 * Announcements to restaurants (docs/SUPER_ADMIN_PLAN.md 14c,
 * docs/DECISIONS.md SA-82+): who sees each, when, and how many hid it.
 */
export function AnnouncementsManager({
  announcements,
  plans,
  cities,
}: {
  announcements: AnnouncementRow[];
  plans: Plan[];
  cities: string[];
}) {
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [pending, startTransition] = useTransition();
  const close = () => setDialog(null);
  const planNames = Object.fromEntries(plans.map((plan) => [plan.code, plan.name]));

  return (
    <>
      <div className="flex justify-end">
        <Button size="touch" onClick={() => setDialog({ kind: 'new' })}>
          <Plus aria-hidden />
          New announcement
        </Button>
      </div>

      {announcements.length === 0 ? (
        <p className="text-sm text-ink-muted">No announcements yet.</p>
      ) : (
        <Table label="Announcements">
          <TableHeader>
            <TableRow>
              <TableHead>Announcement</TableHead>
              <TableHead>For</TableHead>
              <TableHead>Shows</TableHead>
              <TableHead>Hidden by</TableHead>
              <TableHead>Emailed</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {announcements.map((row) => {
              const status = announcementStatus(row);
              return (
                <TableRow key={row.id}>
                  <TableCell className="max-w-72 min-w-48 whitespace-normal">
                    <span className="font-medium text-ink">{row.title}</span>
                    <span className="block text-xs text-ink-muted">
                      {row.panels.map((panel) => PANEL_LABELS[panel]).join(', ')}
                      {row.title_hi && ' · Hindi too'}
                      {!row.dismissible && ' · can’t be dismissed'}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-56 text-sm whitespace-normal">
                    {audienceLabel(row, planNames)}
                    {row.audience !== null && (
                      <span className="block text-xs text-ink-muted">
                        {row.audience} {row.audience === 1 ? 'restaurant' : 'restaurants'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {formatDateTime(row.starts_at)} –{' '}
                    {row.ends_at ? formatDateTime(row.ends_at) : 'no end'}
                  </TableCell>
                  <TableCell className="tabular-nums">{row.dismissed}</TableCell>
                  <TableCell className="tabular-nums">{row.email ? row.emailed : '—'}</TableCell>
                  <TableCell>{STATUS_LABELS[status]}</TableCell>
                  <TableCell>
                    {!row.ended_at && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-11 md:size-8"
                              aria-label={`Actions for ${row.title}`}
                            />
                          }
                        >
                          <MoreHorizontal aria-hidden />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setDialog({ kind: 'edit', row })}>
                            <Pencil aria-hidden /> Change
                          </DropdownMenuItem>
                          {status !== 'ended' && (
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setDialog({ kind: 'end', row })}
                            >
                              <Ban aria-hidden /> End now
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={dialog?.kind === 'new' || dialog?.kind === 'edit'}
        onOpenChange={(open) => !open && close()}
      >
        <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === 'edit' ? 'Change announcement' : 'New announcement'}
            </DialogTitle>
            <DialogDescription>
              A banner at the top of the chosen panels, between its start and end (India time).
            </DialogDescription>
          </DialogHeader>
          {(dialog?.kind === 'new' || dialog?.kind === 'edit') && (
            <AnnouncementForm
              key={dialog.kind === 'edit' ? dialog.row.id : 'new'}
              row={dialog.kind === 'edit' ? dialog.row : undefined}
              plans={plans}
              cities={cities}
              onDone={close}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={dialog?.kind === 'end'} onOpenChange={(open) => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this announcement now?</AlertDialogTitle>
            <AlertDialogDescription>
              Its banner goes from every panel at once, and it can’t be started again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (dialog?.kind !== 'end') return;
                const { row } = dialog;
                startTransition(async () => {
                  const result = await endAnnouncement(row.id);
                  if (result.ok) {
                    toast.success('Announcement ended');
                    close();
                  } else toast.error(result.error);
                });
              }}
            >
              End now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function TextField({
  id,
  label,
  error,
  description,
  ...input
}: React.ComponentProps<typeof Input> & {
  id: string;
  label: string;
  error?: FormFieldError;
  description?: string;
}) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        className="h-11 md:h-9"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...input}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldError id={`${id}-error`} errors={[error]} />
    </Field>
  );
}

function TextAreaField({
  id,
  label,
  error,
  ...input
}: React.ComponentProps<typeof Textarea> & { id: string; label: string; error?: FormFieldError }) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...input}
      />
      <FieldError id={`${id}-error`} errors={[error]} />
    </Field>
  );
}

const EMPTY: AnnouncementInput = {
  title: '',
  body: '',
  titleHi: '',
  bodyHi: '',
  panels: ['admin'],
  audience: 'everyone',
  planCodes: [],
  cities: [],
  restaurants: [],
  startsAt: '',
  endsAt: '',
  dismissible: true,
  email: false,
};

function AnnouncementForm({
  row,
  plans,
  cities,
  onDone,
}: {
  row?: AnnouncementRow;
  plans: Plan[];
  cities: string[];
  onDone: () => void;
}) {
  const ids = useId();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<AnnouncementInput>({
    resolver: zodResolver(announcementSchema),
    defaultValues: row ? announcementForm(row) : EMPTY,
  });
  const [title, body, titleHi, bodyHi, audience, chosen] = useWatch({
    control,
    name: ['title', 'body', 'titleHi', 'bodyHi', 'audience', 'restaurants'],
  });
  // Already emailed restaurants aren't emailed again.
  const emailed = row ? row.emailed : 0;

  const onSubmit = handleSubmit(async (values) => {
    const result = await saveAnnouncement(values, row?.id);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        setError(field as keyof AnnouncementInput, { message });
      }
      if (!result.fieldErrors) setError('root', { message: result.error });
      return;
    }
    toast.success(
      result.data.emailing
        ? 'Saved; emailing the owners now'
        : row
          ? 'Announcement saved'
          : 'Announcement created',
    );
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <TextField
          id={`${ids}-title`}
          label="Title"
          autoComplete="off"
          error={errors.title}
          {...register('title')}
        />
        <TextAreaField id={`${ids}-body`} label="Text" error={errors.body} {...register('body')} />
        <details className="rounded-lg border border-line px-3 py-2 open:pb-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-ink md:min-h-8">
            Hindi (optional)
          </summary>
          <p className="mb-3 text-sm text-ink-muted">
            Shown instead to logins using Hindi in the worker panel. The admin panel and emails stay
            English.
          </p>
          <div className="flex flex-col gap-4">
            <TextField
              id={`${ids}-title-hi`}
              label="Hindi title"
              lang="hi"
              autoComplete="off"
              error={errors.titleHi}
              {...register('titleHi')}
            />
            <TextAreaField
              id={`${ids}-body-hi`}
              label="Hindi text"
              lang="hi"
              error={errors.bodyHi}
              {...register('bodyHi')}
            />
          </div>
        </details>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-ink">Panels</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {PANELS.map((panel) => (
              <label key={panel} className={CHECK_LABEL}>
                <input
                  type="checkbox"
                  value={panel}
                  className="size-4 accent-brand"
                  {...register('panels')}
                />
                {PANEL_LABELS[panel]}
              </label>
            ))}
          </div>
          <FieldError errors={[errors.panels]} />
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-ink">Who sees it</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {AUDIENCES.map((value) => (
              <label key={value} className={CHECK_LABEL}>
                <input
                  type="radio"
                  value={value}
                  className="size-4 accent-brand"
                  {...register('audience')}
                />
                {AUDIENCE_LABELS[value]}
              </label>
            ))}
          </div>
          {audience === 'plans' && (
            <Choices
              label="Plans"
              error={errors.planCodes as FormFieldError | undefined}
              options={plans
                .filter((plan) => plan.active || row?.plan_codes?.includes(plan.code))
                .map((plan) => [
                  plan.code,
                  plan.active ? plan.name : `${plan.name} (switched off)`,
                ])}
              register={register('planCodes')}
            />
          )}
          {audience === 'cities' &&
            (cities.length === 0 ? (
              <p className="text-sm text-ink-muted">No restaurant has a city yet.</p>
            ) : (
              <Choices
                label="Cities"
                error={errors.cities as FormFieldError | undefined}
                options={cities.map((city) => [city, city])}
                register={register('cities')}
              />
            ))}
          {audience === 'restaurants' && (
            <RestaurantPicker
              chosen={chosen}
              error={errors.restaurants as FormFieldError | undefined}
              onChange={(next) => setValue('restaurants', next, { shouldValidate: true })}
            />
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id={`${ids}-starts`}
            label="Starts (empty: now)"
            type="datetime-local"
            error={errors.startsAt}
            {...register('startsAt')}
          />
          <TextField
            id={`${ids}-ends`}
            label="Ends (optional)"
            type="datetime-local"
            error={errors.endsAt}
            {...register('endsAt')}
          />
        </div>
        <label className={CHECK_LABEL}>
          <input type="checkbox" className="size-4 accent-brand" {...register('dismissible')} />
          People can dismiss it
        </label>
        <Field>
          <label className={CHECK_LABEL}>
            <input type="checkbox" className="size-4 accent-brand" {...register('email')} />
            Email the owners when it starts
          </label>
          <FieldDescription>
            Once per restaurant, in English, on its first day: on saving, or at 3 AM for a later
            day.
            {emailed > 0 && ` ${emailed} already emailed aren’t emailed again.`}
          </FieldDescription>
        </Field>

        <section aria-label="Preview" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-ink">Preview</h3>
          <AnnouncementBanner title={title || 'Title'} body={body || 'Text'} lang="en" preview>
            <Button type="button" variant="outline" size="touch" disabled>
              Dismiss
            </Button>
          </AnnouncementBanner>
          {titleHi && bodyHi && (
            <AnnouncementBanner title={titleHi} body={bodyHi} lang="hi" preview>
              <Button type="button" variant="outline" size="touch" disabled lang="hi">
                छिपाएँ
              </Button>
            </AnnouncementBanner>
          )}
        </section>
      </FieldGroup>
      {errors.root && (
        <p role="alert" className="text-sm text-destructive">
          {errors.root.message}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" size="touch" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : row ? 'Save' : 'Create announcement'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Choices({
  label,
  options,
  error,
  register,
}: {
  label: string;
  options: [string, string][];
  error?: FormFieldError;
  register: UseFormRegisterReturn;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{label}</legend>
      <div className="flex max-h-48 flex-wrap gap-x-4 gap-y-2 overflow-y-auto">
        {options.map(([value, name]) => (
          <label key={value} className={CHECK_LABEL}>
            <input type="checkbox" value={value} className="size-4 accent-brand" {...register} />
            {name}
          </label>
        ))}
      </div>
      <FieldError errors={[error]} />
    </fieldset>
  );
}

type Picked = { id: string; name: string };

/** Restaurants by name, from the search box's results. */
function RestaurantPicker({
  chosen,
  error,
  onChange,
}: {
  chosen: Picked[];
  error?: FormFieldError;
  onChange: (next: Picked[]) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [found, setFound] = useState<{ q: string; rows: (Picked & { city: string | null })[] }>();
  const latest = useRef('');

  useEffect(() => {
    latest.current = text;
    if (text.trim().length < 2) return;
    const timer = setTimeout(async () => {
      const result = await searchPlatform(text.trim());
      if (latest.current !== text || !result.ok) return;
      setFound({
        q: text,
        rows: result.data.restaurants.map((restaurant) => ({
          id: restaurant.restaurant_id,
          name: restaurant.name,
          city: restaurant.city,
        })),
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [text]);

  const results =
    found?.q === text ? found.rows.filter((row) => !chosen.some((c) => c.id === row.id)) : [];

  return (
    <div className="flex flex-col gap-2">
      {chosen.length > 0 && (
        <ul aria-label="Chosen restaurants" className="flex flex-wrap gap-2">
          {chosen.map((restaurant) => (
            <li
              key={restaurant.id}
              className="flex items-center gap-1 rounded-full border border-line bg-surface py-0.5 pr-0.5 pl-3 text-sm"
            >
              {restaurant.name}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 rounded-full md:size-7"
                aria-label={`Remove ${restaurant.name}`}
                onClick={() => onChange(chosen.filter((c) => c.id !== restaurant.id))}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={id}>Add a restaurant</FieldLabel>
        <Input
          id={id}
          type="search"
          autoComplete="off"
          className="h-11 md:h-9"
          placeholder="Name or code"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
        />
        <FieldError errors={[error]} />
      </Field>
      {results.length > 0 && (
        <ul aria-label="Matching restaurants" className="flex flex-col divide-y divide-line">
          {results.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 py-1">
              <span className="text-sm">
                {row.name}
                {row.city && <span className="text-ink-muted"> · {row.city}</span>}
              </span>
              <Button
                type="button"
                variant="outline"
                size="touch"
                aria-label={`Add ${row.name}`}
                onClick={() => {
                  onChange([...chosen, { id: row.id, name: row.name }]);
                  setText('');
                }}
              >
                Add
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
