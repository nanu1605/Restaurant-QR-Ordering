'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowDown, ArrowUp, ImagePlus, Plus, Trash2 } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useId, useRef, useState } from 'react';
import { Controller, useFieldArray, useForm, useWatch, type Path } from 'react-hook-form';
import { toast } from 'sonner';

import { FoodTypeMark } from '@/components/shared/food-type-mark';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

import { saveMenuItem } from '../actions';
import { compressMenuImage } from '../compress-image';
import { publicImageUrl } from '../images';
import type { AdminCategory, AdminMenuItem } from '../queries';
import {
  FOOD_TYPES,
  formatPriceInput,
  menuItemFormSchema,
  toMenuItemPayload,
  type MenuItemForm,
} from '../schemas';

const FOOD_TYPE_LABELS: Record<(typeof FOOD_TYPES)[number], string> = {
  veg: 'Veg',
  non_veg: 'Non-veg',
  egg: 'Egg',
};

type ItemFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dish to edit, or null to add one. */
  item: AdminMenuItem | null;
  /** Category preselected for a new dish. */
  categoryId: string | null;
  categories: AdminCategory[];
  supabaseUrl: string;
};

export function ItemFormDialog(props: ItemFormDialogProps) {
  const { open, onOpenChange, item } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{item ? `Edit ${item.name}` : 'Add a dish'}</DialogTitle>
          <DialogDescription>
            Prices are what customers see on the menu. Taxes are added on the bill.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted per opening, so every dish starts from fresh values. */}
        {open && <ItemForm {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function defaultsFor(item: AdminMenuItem | null, categoryId: string | null): MenuItemForm {
  if (item) {
    return {
      id: item.id,
      categoryId: item.categoryId,
      name: item.name,
      description: item.description ?? '',
      foodType: item.foodType,
      hasVariants: item.variants.length > 0,
      price: item.variants.length > 0 ? '' : formatPriceInput(item.pricePaise),
      variants: item.variants.map((variant) => ({
        variantId: variant.id,
        name: variant.name,
        price: formatPriceInput(variant.pricePaise),
      })),
      isAvailable: item.isAvailable,
    };
  }
  return {
    id: crypto.randomUUID(),
    categoryId: categoryId ?? '',
    name: '',
    description: '',
    foodType: 'veg',
    hasVariants: false,
    price: '',
    variants: [],
    isAvailable: true,
  };
}

/** Server field names (database payload) → form field names. */
function formField(key: string): Path<MenuItemForm> {
  const mapped = key
    .replace(/^category_id$/, 'categoryId')
    .replace(/^food_type$/, 'foodType')
    .replace(/^price_paise$/, 'price')
    .replace(/^is_available$/, 'isAvailable')
    .replace(/^variants\.(\d+)\.price_paise$/, 'variants.$1.price');
  return mapped as Path<MenuItemForm>;
}

type ImageState = { file: File | null; preview: string | null; remove: boolean };

function ItemForm({
  item,
  categoryId,
  categories,
  supabaseUrl,
  onOpenChange,
}: ItemFormDialogProps) {
  const ids = useId();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(menuItemFormSchema),
    defaultValues: defaultsFor(item, categoryId),
  });
  const variants = useFieldArray({ control, name: 'variants' });
  // useWatch rather than watch(): it stays correct with the React Compiler.
  const hasVariants = useWatch({ control, name: 'hasVariants' });
  const description = useWatch({ control, name: 'description' }) ?? '';

  const [image, setImage] = useState<ImageState>(() => ({
    file: null,
    preview: item?.imagePath
      ? publicImageUrl(supabaseUrl, 'menu-images', item.imagePath, item.updatedAt)
      : null,
    remove: false,
  }));
  const [preparingImage, setPreparingImage] = useState(false);
  const objectUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  async function pickImage(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Choose a photo (JPG, PNG or WebP).');
      return;
    }
    setPreparingImage(true);
    try {
      const compressed = await compressMenuImage(file);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(compressed);
      setImage({ file: compressed, preview: objectUrl.current, remove: false });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'This photo could not be used. Try another one.',
      );
    } finally {
      setPreparingImage(false);
    }
  }

  const onSubmit = handleSubmit(async (values) => {
    const formData = new FormData();
    formData.set('item', JSON.stringify(toMenuItemPayload(values)));
    if (image.file) formData.set('image', image.file);
    if (image.remove) formData.set('removeImage', 'true');

    const result = await saveMenuItem(formData);
    if (!result.ok) {
      for (const [key, message] of Object.entries(result.fieldErrors ?? {})) {
        setError(formField(key), { message });
      }
      setError('root', { message: result.error });
      return;
    }
    toast.success(item ? `Saved “${values.name}”` : `Added “${values.name}”`);
    onOpenChange(false);
  });

  const categoryItems = categories.map((category) => ({
    value: category.id,
    label: category.isActive ? category.name : `${category.name} (hidden)`,
  }));
  const variantListError = errors.variants?.message ?? errors.variants?.root?.message;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-4">
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-name`}>Dish name</FieldLabel>
          <Input
            id={`${ids}-name`}
            maxLength={80}
            autoComplete="off"
            aria-invalid={errors.name ? true : undefined}
            className="h-9"
            {...register('name')}
          />
          <FieldError errors={[errors.name]} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={errors.categoryId ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-category`}>Category</FieldLabel>
            <Controller
              control={control}
              name="categoryId"
              render={({ field }) => (
                <Select
                  items={categoryItems}
                  value={field.value || null}
                  onValueChange={(value) => field.onChange(value ?? '')}
                >
                  <SelectTrigger
                    id={`${ids}-category`}
                    className="h-9 w-full"
                    aria-invalid={errors.categoryId ? true : undefined}
                  >
                    <SelectValue placeholder="Choose a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryItems.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <FieldError errors={[errors.categoryId]} />
          </Field>

          <Field data-invalid={errors.foodType ? true : undefined}>
            <FieldLabel id={`${ids}-food`}>Food type</FieldLabel>
            <Controller
              control={control}
              name="foodType"
              render={({ field }) => (
                <RadioGroup
                  aria-labelledby={`${ids}-food`}
                  value={field.value}
                  onValueChange={(value) => field.onChange(value)}
                  className="flex h-9 items-center gap-4"
                >
                  {FOOD_TYPES.map((type) => (
                    <label
                      key={type}
                      className="flex items-center gap-2 text-sm whitespace-nowrap text-ink"
                    >
                      <RadioGroupItem value={type} aria-label={FOOD_TYPE_LABELS[type]} />
                      <FoodTypeMark type={type} size="sm" />
                      {FOOD_TYPE_LABELS[type]}
                    </label>
                  ))}
                </RadioGroup>
              )}
            />
            <FieldError errors={[errors.foodType]} />
          </Field>
        </div>

        <Field data-invalid={errors.description ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-description`}>Description (optional)</FieldLabel>
          <Textarea
            id={`${ids}-description`}
            rows={2}
            maxLength={300}
            aria-invalid={errors.description ? true : undefined}
            {...register('description')}
          />
          <FieldDescription className="text-right text-xs tabular-nums">
            {description.length}/300
          </FieldDescription>
          <FieldError errors={[errors.description]} />
        </Field>

        <Field orientation="horizontal">
          <Controller
            control={control}
            name="hasVariants"
            render={({ field }) => (
              <Switch
                id={`${ids}-has-variants`}
                checked={field.value}
                onCheckedChange={(checked) => {
                  field.onChange(checked);
                  if (checked && variants.fields.length === 0) {
                    variants.append([
                      { name: '', price: '' },
                      { name: '', price: '' },
                    ]);
                  }
                }}
              />
            )}
          />
          <FieldLabel htmlFor={`${ids}-has-variants`} className="font-normal">
            This dish has options with their own prices, e.g. Half / Full
          </FieldLabel>
        </Field>

        {hasVariants ? (
          <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3">
            <legend className="px-1 text-sm font-medium text-ink">Options</legend>
            {variants.fields.map((field, index) => (
              <div key={field.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Option ${index + 1} name`}
                    placeholder={
                      index === 0 ? 'e.g. Half' : index === 1 ? 'e.g. Full' : 'Option name'
                    }
                    maxLength={40}
                    aria-invalid={errors.variants?.[index]?.name ? true : undefined}
                    className="h-9 flex-1"
                    {...register(`variants.${index}.name`)}
                  />
                  <div className="relative w-28 shrink-0">
                    <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-ink-muted">
                      ₹
                    </span>
                    <Input
                      aria-label={`Option ${index + 1} price in rupees`}
                      inputMode="decimal"
                      aria-invalid={errors.variants?.[index]?.price ? true : undefined}
                      className="h-9 pl-6 text-right tabular-nums"
                      {...register(`variants.${index}.price`)}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => variants.move(index, index - 1)}
                    disabled={index === 0}
                    aria-label={`Move option ${index + 1} up`}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => variants.move(index, index + 1)}
                    disabled={index === variants.fields.length - 1}
                    aria-label={`Move option ${index + 1} down`}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => variants.remove(index)}
                    aria-label={`Remove option ${index + 1}`}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
                <FieldError
                  errors={[errors.variants?.[index]?.name, errors.variants?.[index]?.price]}
                />
              </div>
            ))}
            {variantListError && <FieldError>{variantListError}</FieldError>}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => variants.append({ name: '', price: '' })}
              disabled={variants.fields.length >= 20}
            >
              <Plus aria-hidden /> Add option
            </Button>
          </fieldset>
        ) : (
          <Field data-invalid={errors.price ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-price`}>Price</FieldLabel>
            <div className="relative w-40">
              <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-ink-muted">
                ₹
              </span>
              <Input
                id={`${ids}-price`}
                inputMode="decimal"
                placeholder="0"
                aria-invalid={errors.price ? true : undefined}
                className="h-9 pl-6 text-right tabular-nums"
                {...register('price')}
              />
            </div>
            <FieldError errors={[errors.price]} />
          </Field>
        )}

        <Field>
          <FieldLabel htmlFor={`${ids}-image`}>Photo (optional)</FieldLabel>
          <div className="flex items-center gap-3">
            <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
              {image.preview ? (
                <Image
                  src={image.preview}
                  alt="Dish photo preview"
                  width={80}
                  height={80}
                  unoptimized
                  className="size-20 object-cover"
                />
              ) : (
                <ImagePlus aria-hidden className="size-6 text-ink-muted" />
              )}
            </div>
            <div className="flex flex-col items-start gap-1.5">
              <input
                id={`${ids}-image`}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:file:bg-muted"
                disabled={preparingImage || isSubmitting}
                onChange={(event) => {
                  void pickImage(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              {preparingImage && (
                <span role="status" className="text-xs text-ink-muted">
                  Preparing photo…
                </span>
              )}
              {image.preview && !preparingImage && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setImage({ file: null, preview: null, remove: Boolean(item?.imagePath) })
                  }
                >
                  <Trash2 aria-hidden /> Remove photo
                </Button>
              )}
            </div>
          </div>
          <FieldDescription>
            Resized to 800 px before upload to keep the menu fast.
          </FieldDescription>
        </Field>

        <Field orientation="horizontal">
          <Controller
            control={control}
            name="isAvailable"
            render={({ field }) => (
              <Switch
                id={`${ids}-available`}
                checked={field.value}
                onCheckedChange={(checked) => field.onChange(checked)}
              />
            )}
          />
          <FieldLabel htmlFor={`${ids}-available`} className="font-normal">
            In stock (customers can order it)
          </FieldLabel>
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
        <Button type="submit" size="lg" disabled={isSubmitting || preparingImage}>
          {isSubmitting ? 'Saving…' : item ? 'Save dish' : 'Add dish'}
        </Button>
      </DialogFooter>
    </form>
  );
}
