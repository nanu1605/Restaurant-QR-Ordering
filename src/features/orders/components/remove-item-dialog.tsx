'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { QuantityStepper } from '@/features/ordering/components/quantity-stepper';
import { dishName } from '@/features/ordering/format';

import { removeItem } from '../actions';
import type { BoardItem } from '../board';
import { REMOVE_REASONS } from '../schemas';
import { useStaffStrings } from '../staff-lang';
import { useBoardAction } from '../use-board';
import { ReasonDialog } from './reason-dialog';

type RemoveItemDialogProps = {
  item: BoardItem | null;
  onClose: () => void;
};

/**
 * "Remove dish" (spec §13.2, §10.8): how many (for multi-quantity lines) and
 * why. Removing fewer than all reduces the line; the rest stays on the order.
 */
export function RemoveItemDialog({ item, onClose }: RemoveItemDialogProps) {
  return <ReasonDialogForItem key={item?.id ?? 'none'} item={item} onClose={onClose} />;
}

function ReasonDialogForItem({ item, onClose }: RemoveItemDialogProps) {
  const [quantity, setQuantity] = useState(item?.quantity ?? 1);
  const remove = useBoardAction({ action: removeItem });
  const t = useStaffStrings();
  const name = item ? dishName(item) : '';

  return (
    <ReasonDialog
      open={item !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t.remove.title(name)}
      description={
        item && quantity < item.quantity
          ? t.remove.keeps(item.quantity - quantity, name)
          : t.remove.struck
      }
      presets={REMOVE_REASONS}
      confirmLabel={
        item && quantity < item.quantity ? t.remove.confirmSome(quantity) : t.remove.confirmAll
      }
      destructive
      onConfirm={async (reason) => {
        if (!item) return true;
        try {
          await remove.mutateAsync({ itemId: item.id, quantity, reason });
          toast.success(
            quantity < item.quantity
              ? t.remove.removedSome(quantity, name)
              : t.remove.removed(name),
          );
          return true;
        } catch {
          return false;
        }
      }}
    >
      {item && item.quantity > 1 && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-ink">
            {t.remove.howMany}{' '}
            <span className="font-normal text-ink-muted">{t.remove.of(item.quantity)}</span>
          </span>
          <QuantityStepper
            value={quantity}
            onChange={setQuantity}
            itemName={name}
            labels={t.remove.stepper}
            min={1}
            max={item.quantity}
          />
        </div>
      )}
    </ReasonDialog>
  );
}
