'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState, useTransition } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';

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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { groupRule } from '@/features/ordering/addons';
import { formatINR } from '@/lib/money';

import { deleteAddonGroup, saveAddonGroup } from '../actions';
import type { AdminAddonGroup } from '../queries';
import {
  addonGroupFormSchema,
  formatPriceInput,
  toAddonGroupPayload,
  type AddonGroupForm,
} from '../schemas';

type AddonGroupsPanelProps = {
  groups: AdminAddonGroup[];
  /** How many dishes use each group. */
  dishCounts: Record<string, number>;
  readOnly: boolean;
};

const dishes = (count: number) => `${count} ${count === 1 ? 'dish' : 'dishes'}`;

/** Add-ons on the Menu page (docs/DECISIONS.md P9-4): shared groups, attached from the dish form. */
export function AddonGroupsPanel({ groups, dishCounts, readOnly }: AddonGroupsPanelProps) {
  const [editing, setEditing] = useState<{ group: AdminAddonGroup | null } | null>(null);
  const [deleting, setDeleting] = useState<AdminAddonGroup | null>(null);

  return (
    <section
      aria-labelledby="addons-heading"
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 px-1">
        <div className="flex flex-col gap-0.5">
          <h2 id="addons-heading" className="text-base font-semibold text-ink">
            Add-ons
          </h2>
          <p className="text-sm text-ink-muted">
            Extras such as toppings or a choice of crust, shared by many dishes. Add a group here,
            then tick it when you edit a dish.
          </p>
        </div>
        <Button variant="outline" onClick={() => setEditing({ group: null })} disabled={readOnly}>
          <Plus aria-hidden /> New add-on group
        </Button>
      </div>

      {groups.length === 0 ? (
        <p className="px-1 text-sm text-ink-muted">No add-on groups yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {groups.map((group) => (
            <li
              key={group.id}
              className="flex flex-wrap items-center justify-between gap-2 px-1 py-2"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="text-base font-medium text-ink">
                  {group.name}{' '}
                  <span className="text-sm font-normal text-ink-muted">
                    · {groupRule(group)} · on {dishes(dishCounts[group.id] ?? 0)}
                  </span>
                </p>
                <p className="text-sm text-ink-muted">
                  {group.addons.map((addon, index) => (
                    <span key={addon.id}>
                      {index > 0 && ' · '}
                      {addon.name}
                      {addon.pricePaise > 0 && (
                        <span className="whitespace-nowrap">
                          {' '}
                          +{formatINR(addon.pricePaise, { fraction: 'auto' })}
                        </span>
                      )}
                      {!addon.isAvailable && ' (out of stock)'}
                    </span>
                  ))}
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing({ group })}
                  disabled={readOnly}
                >
                  <Pencil aria-hidden /> Edit<span className="sr-only"> {group.name}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleting(group)}
                  disabled={readOnly}
                >
                  <Trash2 aria-hidden /> Delete<span className="sr-only"> {group.name}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editing?.group ? `Edit ${editing.group.name}` : 'New add-on group'}
            </DialogTitle>
            <DialogDescription>
              Prices are added to the dish price. Taxes are added on the bill.
            </DialogDescription>
          </DialogHeader>
          {/* Mounted per opening, so every group starts from fresh values. */}
          {editing && <AddonGroupForm group={editing.group} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>

      <DeleteAddonGroupDialog
        group={deleting}
        dishCount={deleting ? (dishCounts[deleting.id] ?? 0) : 0}
        onClose={() => setDeleting(null)}
      />
    </section>
  );
}

function defaultsFor(group: AdminAddonGroup | null): AddonGroupForm {
  if (group) {
    return {
      name: group.name,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      addons: group.addons.map((addon) => ({
        addonId: addon.id,
        name: addon.name,
        price: formatPriceInput(addon.pricePaise),
      })),
    };
  }
  return {
    name: '',
    minSelect: 0,
    maxSelect: 1,
    addons: [
      { name: '', price: '' },
      { name: '', price: '' },
    ],
  };
}

function AddonGroupForm({ group, onDone }: { group: AdminAddonGroup | null; onDone: () => void }) {
  const ids = useId();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(addonGroupFormSchema),
    defaultValues: defaultsFor(group),
  });
  const addons = useFieldArray({ control, name: 'addons' });
  const listError = errors.addons?.message ?? errors.addons?.root?.message;

  const onSubmit = handleSubmit(async (values) => {
    const result = await saveAddonGroup(toAddonGroupPayload(group?.id ?? null, values));
    if (!result.ok) {
      setError('root', { message: result.error });
      return;
    }
    toast.success(group ? `Saved “${values.name}”` : `Added “${values.name}”`);
    onDone();
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-name`}>Group name</FieldLabel>
          <Input
            id={`${ids}-name`}
            maxLength={60}
            autoComplete="off"
            placeholder="e.g. Toppings"
            aria-invalid={errors.name ? true : undefined}
            className="h-9"
            {...register('name')}
          />
          <FieldError errors={[errors.name]} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={errors.minSelect ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-min`}>Customers must choose at least</FieldLabel>
            <Input
              id={`${ids}-min`}
              type="number"
              inputMode="numeric"
              min={0}
              max={20}
              aria-invalid={errors.minSelect ? true : undefined}
              className="h-9 w-24"
              {...register('minSelect', { valueAsNumber: true })}
            />
            <FieldDescription>0 makes the group optional.</FieldDescription>
            <FieldError errors={[errors.minSelect]} />
          </Field>
          <Field data-invalid={errors.maxSelect ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-max`}>And at most</FieldLabel>
            <Input
              id={`${ids}-max`}
              type="number"
              inputMode="numeric"
              min={1}
              max={20}
              aria-invalid={errors.maxSelect ? true : undefined}
              className="h-9 w-24"
              {...register('maxSelect', { valueAsNumber: true })}
            />
            <FieldError errors={[errors.maxSelect]} />
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-medium text-ink">Add-ons</legend>
          {addons.fields.map((field, index) => (
            <div key={field.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Add-on ${index + 1} name`}
                  placeholder={index === 0 ? 'e.g. Extra cheese' : 'Add-on name'}
                  maxLength={40}
                  aria-invalid={errors.addons?.[index]?.name ? true : undefined}
                  className="h-9 flex-1"
                  {...register(`addons.${index}.name`)}
                />
                <div className="relative w-28 shrink-0">
                  <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-ink-muted">
                    ₹
                  </span>
                  <Input
                    aria-label={`Add-on ${index + 1} price in rupees`}
                    inputMode="decimal"
                    placeholder="0"
                    aria-invalid={errors.addons?.[index]?.price ? true : undefined}
                    className="h-9 pl-6 text-right tabular-nums"
                    {...register(`addons.${index}.price`)}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => addons.move(index, index - 1)}
                  disabled={index === 0}
                  aria-label={`Move add-on ${index + 1} up`}
                >
                  <ArrowUp aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => addons.move(index, index + 1)}
                  disabled={index === addons.fields.length - 1}
                  aria-label={`Move add-on ${index + 1} down`}
                >
                  <ArrowDown aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => addons.remove(index)}
                  aria-label={`Remove add-on ${index + 1}`}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
              <FieldError errors={[errors.addons?.[index]?.name, errors.addons?.[index]?.price]} />
            </div>
          ))}
          {listError && <FieldError>{listError}</FieldError>}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => addons.append({ name: '', price: '' })}
            disabled={addons.fields.length >= 30}
          >
            <Plus aria-hidden /> Add an add-on
          </Button>
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
          {isSubmitting ? 'Saving…' : group ? 'Save group' : 'Add group'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteAddonGroupDialog({
  group,
  dishCount,
  onClose,
}: {
  group: AdminAddonGroup | null;
  dishCount: number;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function remove() {
    if (!group) return;
    startTransition(async () => {
      const result = await deleteAddonGroup(group.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`Deleted “${group.name}”`);
      onClose();
    });
  }

  return (
    <Dialog open={group !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{group?.name}”?</DialogTitle>
          <DialogDescription>
            {dishCount > 0 ? `It comes off ${dishes(dishCount)}. ` : ''}
            Orders already placed keep their add-ons. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" size="lg" />}>
            Cancel
          </DialogClose>
          <Button variant="destructive" size="lg" onClick={remove} disabled={pending}>
            {pending ? 'Deleting…' : 'Delete group'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
