'use client';

import { XIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatINR } from '@/lib/money';

import { groupRule, selectionError } from '../addons';
import { cartLineFor, type NewCartLine } from '../cart';
import { MAX_LINE_NOTE } from '../limits';
import type { CustomerAddon, CustomerAddonGroup, CustomerMenuItem } from '../types';
import { QuantityStepper } from './quantity-stepper';

type OptionsSheetProps = {
  item: CustomerMenuItem | null;
  onClose: () => void;
  onAdd: (line: NewCartLine, quantity: number, note: string) => void;
  /** The add button's words: staff add to a round, not a cart. */
  addLabel?: string;
};

const price = (paise: number) => formatINR(paise, { fraction: 'auto' });

// The ring colour (3:1 on white) marks a chosen option on any accent.
const CHOICE_CLASS =
  'flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-lg border border-line px-3 text-base text-ink has-data-checked:border-2 has-data-checked:border-ring has-data-disabled:cursor-not-allowed has-data-disabled:text-ink-muted';

/**
 * Bottom sheet for dishes with options or add-ons (spec §13.1, docs/DECISIONS.md
 * P9-4): option, add-ons, quantity and a note, with the price as chosen.
 */
export function OptionsSheet({
  item,
  onClose,
  onAdd,
  addLabel = 'Add to cart',
}: OptionsSheetProps) {
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="mx-auto max-h-[90dvh] max-w-[560px] gap-0 overflow-y-auto rounded-t-2xl"
      >
        {item && <OptionsForm key={item.id} item={item} onAdd={onAdd} addLabel={addLabel} />}
        <SheetClose
          render={<Button variant="ghost" size="icon-touch" className="absolute top-2 right-2" />}
        >
          <XIcon aria-hidden />
          <span className="sr-only">Close</span>
        </SheetClose>
      </SheetContent>
    </Sheet>
  );
}

function OptionsForm({
  item,
  onAdd,
  addLabel,
}: Required<Pick<OptionsSheetProps, 'onAdd' | 'addLabel'>> & { item: CustomerMenuItem }) {
  const ids = useId();
  const [variantId, setVariantId] = useState(item.variants[0]?.id ?? null);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const line = cartLineFor(item, variantId, addonIds);
  const error = selectionError(item.addonGroups, addonIds);

  function choose(group: CustomerAddonGroup, addon: CustomerAddon, checked: boolean) {
    const inGroup = new Set(group.addons.map((a) => a.id));
    setAddonIds((current) => {
      if (!checked) return current.filter((id) => id !== addon.id);
      // A group of one swaps its choice; a full group takes no more.
      if (group.maxSelect === 1) return [...current.filter((id) => !inGroup.has(id)), addon.id];
      const chosen = current.filter((id) => inGroup.has(id)).length;
      return chosen < group.maxSelect ? [...current, addon.id] : current;
    });
  }

  return (
    <>
      <SheetHeader className="pr-14">
        <SheetTitle className="flex items-center gap-2 text-lg font-semibold text-ink">
          <FoodTypeMark type={item.foodType} size="sm" />
          {item.name}
        </SheetTitle>
        {item.description && <SheetDescription>{item.description}</SheetDescription>}
      </SheetHeader>

      <div className="flex flex-col gap-5 px-4 pb-2">
        {item.variants.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend id={`${ids}-options`} className="mb-2 text-sm font-semibold text-ink">
              Choose an option
            </legend>
            <RadioGroup
              aria-labelledby={`${ids}-options`}
              value={variantId}
              onValueChange={(value) => setVariantId(String(value))}
              className="gap-2"
            >
              {item.variants.map((option) => (
                <label key={option.id} className={CHOICE_CLASS}>
                  <span className="flex items-center gap-3">
                    <RadioGroupItem value={option.id} className="data-checked:border-ring" />
                    {option.name}
                  </span>
                  <span className="shrink-0 tabular-nums">{price(option.pricePaise)}</span>
                </label>
              ))}
            </RadioGroup>
          </fieldset>
        )}

        {item.addonGroups.map((group) => {
          const legendId = `${ids}-${group.id}`;
          const chosen = group.addons.filter((a) => addonIds.includes(a.id)).length;
          const full = group.maxSelect > 1 && chosen >= group.maxSelect;
          return (
            <fieldset key={group.id} className="flex flex-col gap-2">
              <legend id={legendId} className="mb-2 text-sm font-semibold text-ink">
                {group.name}{' '}
                <span className="font-normal text-ink-muted">· {groupRule(group)}</span>
              </legend>
              {group.minSelect === 1 && group.maxSelect === 1 ? (
                <RadioGroup
                  aria-labelledby={legendId}
                  value={group.addons.find((a) => addonIds.includes(a.id))?.id ?? null}
                  onValueChange={(value) => {
                    const addon = group.addons.find((a) => a.id === value);
                    if (addon) choose(group, addon, true);
                  }}
                  className="gap-2"
                >
                  {group.addons.map((addon) => (
                    <label key={addon.id} className={CHOICE_CLASS}>
                      <span className="flex items-center gap-3">
                        <RadioGroupItem
                          value={addon.id}
                          disabled={!addon.isAvailable}
                          className="data-checked:border-ring"
                        />
                        <AddonName addon={addon} />
                      </span>
                      <AddonPrice addon={addon} />
                    </label>
                  ))}
                </RadioGroup>
              ) : (
                group.addons.map((addon) => {
                  const checked = addonIds.includes(addon.id);
                  return (
                    <label key={addon.id} className={CHOICE_CLASS}>
                      <span className="flex items-center gap-3">
                        <Checkbox
                          checked={checked}
                          disabled={!addon.isAvailable || (full && !checked)}
                          onCheckedChange={(next) => choose(group, addon, next)}
                          className="data-checked:border-ring"
                        />
                        <AddonName addon={addon} />
                      </span>
                      <AddonPrice addon={addon} />
                    </label>
                  );
                })
              )}
            </fieldset>
          );
        })}

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-ink">Quantity</span>
          <QuantityStepper value={quantity} onChange={setQuantity} itemName={item.name} min={1} />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-note`} className="text-sm font-semibold text-ink">
            Note for the kitchen <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <Input
            id={`${ids}-note`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={MAX_LINE_NOTE}
            placeholder="e.g. less spicy"
            className="h-11 text-base"
          />
        </div>
      </div>

      <SheetFooter className="gap-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {error && (
          <p id={`${ids}-error`} className="text-center text-sm text-ink-muted">
            {error}
          </p>
        )}
        <Button
          size="touch"
          className="w-full"
          disabled={error !== null}
          aria-describedby={error ? `${ids}-error` : undefined}
          onClick={() => onAdd(line, quantity, note)}
        >
          {addLabel} · <span className="tabular-nums">{price(line.unitPricePaise * quantity)}</span>
        </Button>
      </SheetFooter>
    </>
  );
}

function AddonName({ addon }: { addon: CustomerAddon }) {
  return (
    <span>
      {addon.name}
      {!addon.isAvailable && <span className="text-sm"> · Not available</span>}
    </span>
  );
}

function AddonPrice({ addon }: { addon: CustomerAddon }) {
  return addon.pricePaise > 0 ? (
    <span className="shrink-0 whitespace-nowrap tabular-nums">+{price(addon.pricePaise)}</span>
  ) : null;
}
