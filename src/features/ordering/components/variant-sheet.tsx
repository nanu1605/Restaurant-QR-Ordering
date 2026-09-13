'use client';

import { XIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
import { Button } from '@/components/ui/button';
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

import { MAX_LINE_NOTE } from '../limits';
import type { CustomerMenuItem, CustomerVariant } from '../types';
import { QuantityStepper } from './quantity-stepper';

type VariantSheetProps = {
  item: CustomerMenuItem | null;
  onClose: () => void;
  onAdd: (item: CustomerMenuItem, variant: CustomerVariant, quantity: number, note: string) => void;
};

/** Bottom sheet for dishes with options: option, quantity and a note (spec §13.1). */
export function VariantSheet({ item, onClose, onAdd }: VariantSheetProps) {
  return (
    <Sheet open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="mx-auto max-h-[90dvh] max-w-[560px] gap-0 overflow-y-auto rounded-t-2xl"
      >
        {item && <VariantForm key={item.id} item={item} onAdd={onAdd} />}
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

function VariantForm({
  item,
  onAdd,
}: {
  item: CustomerMenuItem;
  onAdd: VariantSheetProps['onAdd'];
}) {
  const ids = useId();
  const [variantId, setVariantId] = useState(item.variants[0]?.id ?? '');
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const variant = item.variants.find((v) => v.id === variantId);

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
              <label
                key={option.id}
                // The ring colour (3:1 on white) marks the chosen option on any accent.
                className="flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-lg border border-line px-3 text-base text-ink has-data-checked:border-2 has-data-checked:border-ring"
              >
                <span className="flex items-center gap-3">
                  <RadioGroupItem value={option.id} className="data-checked:border-ring" />
                  {option.name}
                </span>
                <span className="tabular-nums">
                  {formatINR(option.pricePaise, { fraction: 'auto' })}
                </span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>

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

      <SheetFooter className="pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button
          size="touch"
          className="w-full"
          disabled={!variant}
          onClick={() => variant && onAdd(item, variant, quantity, note)}
        >
          Add to cart ·{' '}
          <span className="tabular-nums">
            {variant ? formatINR(variant.pricePaise * quantity, { fraction: 'auto' }) : ''}
          </span>
        </Button>
      </SheetFooter>
    </>
  );
}
