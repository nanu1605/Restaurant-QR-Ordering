'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ImagePlus, Printer, Trash2 } from 'lucide-react';
import Image from 'next/image';
import QRCode from 'qrcode';
import { useEffect, useId, useState, useTransition, type ReactNode } from 'react';
import {
  Controller,
  useForm,
  useWatch,
  type FieldValues,
  type Path,
  type UseFormReturn,
} from 'react-hook-form';
import { toast } from 'sonner';

import { Button, buttonVariants } from '@/components/ui/button';
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
import { compressMenuImage } from '@/features/menu/compress-image';
import { publicImageUrl } from '@/features/menu/images';
import { buildUpiUrl, UPI_VPA_PATTERN } from '@/lib/upi';

import { removeLogo, saveSettings, uploadLogo, type SettingsTabName } from '../actions';
import type { RestaurantSettings } from '../queries';
import {
  billTabSchema,
  bpsToPercent,
  GST_RATES_BPS,
  orderingTabSchema,
  restaurantTabSchema,
  taxTabSchema,
  type BillTab,
  type OrderingTab,
  type RestaurantTab,
  type TaxTab,
} from '../schemas';

type FormProps = { settings: RestaurantSettings; readOnly: boolean };

// Forms follow the server's values (`values` + keepDirtyValues) instead of
// remounting, so the refresh after a save, which can land a moment later,
// never wipes what is being typed, in this tab or another.
const FOLLOW_SERVER = { keepDirtyValues: true } as const;

function useSave<T extends FieldValues>(
  tab: SettingsTabName,
  form: Pick<UseFormReturn<T>, 'getValues' | 'resetDefaultValues' | 'setError'>,
) {
  return async (values: T) => {
    const submitted = form.getValues();
    const result = await saveSettings(tab, values);
    if (!result.ok) {
      for (const [key, message] of Object.entries(result.fieldErrors ?? {})) {
        form.setError(key as Path<T>, { message });
      }
      if (!result.fieldErrors) form.setError('root' as Path<T>, { message: result.error });
      else toast.error(result.error);
      return;
    }
    // Saved fields are no longer edits, so the refresh shows what was stored
    // (e.g. the GSTIN in capitals); anything typed since stays put.
    form.resetDefaultValues(submitted);
    toast.success('Settings saved');
  };
}

function SaveBar({
  pending,
  readOnly,
  error,
}: {
  pending: boolean;
  readOnly: boolean;
  error?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
      {error && (
        <p role="alert" className="mr-auto text-sm font-medium text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending || readOnly}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}

function SwitchField({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
  hint,
}: {
  id: string;
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Field orientation="horizontal" className="items-start">
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="mt-0.5"
      />
      <div className="flex flex-col gap-0.5">
        <FieldLabel htmlFor={id} className="font-normal">
          {label}
          {hint && (
            <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-brand">
              {hint}
            </span>
          )}
        </FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
      </div>
    </Field>
  );
}

// ─── Restaurant ─────────────────────────────────────────────────────────────
export function RestaurantForm({
  settings,
  readOnly,
  supabaseUrl,
}: FormProps & { supabaseUrl: string }) {
  const ids = useId();
  const form = useForm({
    resolver: zodResolver(restaurantTabSchema),
    values: {
      name: settings.name,
      legalName: settings.legal_name ?? '',
      addressLine: settings.address_line ?? '',
      city: settings.city ?? '',
      state: settings.state ?? '',
      pincode: settings.pincode ?? '',
      phone: settings.phone ?? '',
      email: settings.email ?? '',
      accentColor: settings.accent_color,
    } satisfies RestaurantTab,
    resetOptions: FOLLOW_SERVER,
  });
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form;
  const save = useSave<RestaurantTab>('restaurant', form);
  const text = (name: keyof RestaurantTab, label: string, props: object = {}) => (
    <Field data-invalid={errors[name] ? true : undefined}>
      <FieldLabel htmlFor={`${ids}-${name}`}>{label}</FieldLabel>
      <Input
        id={`${ids}-${name}`}
        className="h-9"
        disabled={readOnly}
        {...props}
        {...register(name)}
      />
      <FieldError errors={[errors[name]]} />
    </Field>
  );

  return (
    <div className="flex flex-col gap-6">
      <LogoField settings={settings} readOnly={readOnly} supabaseUrl={supabaseUrl} />
      <form onSubmit={handleSubmit(save)} noValidate className="flex flex-col gap-5">
        <FieldGroup className="gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {text('name', 'Restaurant name')}
            {text('legalName', 'Legal name (optional, printed on bills)')}
          </div>
          {text('addressLine', 'Address')}
          <div className="grid gap-4 sm:grid-cols-3">
            {text('city', 'City')}
            {text('state', 'State')}
            {text('pincode', 'Pincode', { inputMode: 'numeric', maxLength: 6 })}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {text('phone', 'Phone', { type: 'tel' })}
            {text('email', 'Email', { type: 'email' })}
          </div>
          <Field data-invalid={errors.accentColor ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-accent`}>Accent colour</FieldLabel>
            <Controller
              control={control}
              name="accentColor"
              render={({ field }) => (
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    aria-label="Pick accent colour"
                    value={field.value}
                    onChange={(event) => field.onChange(event.target.value)}
                    disabled={readOnly}
                    className="h-9 w-12 cursor-pointer rounded-md border border-line bg-surface p-1"
                  />
                  <Input
                    id={`${ids}-accent`}
                    value={field.value}
                    onChange={(event) => field.onChange(event.target.value)}
                    disabled={readOnly}
                    maxLength={7}
                    className="h-9 w-28 font-mono"
                  />
                </div>
              )}
            />
            <FieldDescription>
              Used for buttons and highlights on your customer menu.
            </FieldDescription>
            <FieldError errors={[errors.accentColor]} />
          </Field>
        </FieldGroup>
        <SaveBar pending={isSubmitting} readOnly={readOnly} error={errors.root?.message} />
      </form>
    </div>
  );
}

function LogoField({ settings, readOnly, supabaseUrl }: FormProps & { supabaseUrl: string }) {
  const [pending, startTransition] = useTransition();
  const logoUrl = settings.logo_path
    ? publicImageUrl(supabaseUrl, 'logos', settings.logo_path, settings.updated_at)
    : null;

  function upload(file: File | undefined) {
    if (!file) return;
    startTransition(async () => {
      try {
        const compressed = await compressMenuImage(file, 512);
        const formData = new FormData();
        formData.set('logo', compressed);
        const result = await uploadLogo(formData);
        if (!result.ok) toast.error(result.error);
        else toast.success('Logo updated');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'This image could not be used.');
      }
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await removeLogo();
      if (!result.ok) toast.error(result.error);
      else toast.success('Logo removed');
    });
  }

  return (
    <Field>
      <FieldLabel htmlFor="restaurant-logo">Logo (optional)</FieldLabel>
      <div className="flex items-center gap-4">
        <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-muted">
          {logoUrl ? (
            <Image
              src={logoUrl}
              alt="Restaurant logo"
              width={80}
              height={80}
              unoptimized
              className="size-20 object-contain"
            />
          ) : (
            <ImagePlus aria-hidden className="size-6 text-ink-muted" />
          )}
        </div>
        <div className="flex flex-col items-start gap-1.5">
          <input
            id="restaurant-logo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={readOnly || pending}
            onChange={(event) => {
              upload(event.target.files?.[0]);
              event.target.value = '';
            }}
            className="text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:file:bg-muted"
          />
          {pending && (
            <span role="status" className="text-xs text-ink-muted">
              Saving logo…
            </span>
          )}
          {logoUrl && !pending && (
            <Button type="button" variant="ghost" size="sm" onClick={remove} disabled={readOnly}>
              <Trash2 aria-hidden /> Remove logo
            </Button>
          )}
        </div>
      </div>
      <FieldDescription>
        Shown at the top of your customer menu. Square images work best.
      </FieldDescription>
    </Field>
  );
}

// ─── Tax & charges ──────────────────────────────────────────────────────────
const GST_MODE_OPTIONS = [
  { value: 'none', label: 'No GST', description: 'Not registered for GST. Bills show no tax.' },
  {
    value: 'regular',
    label: 'Regular GST',
    description: 'GST at the rate below is added to (or included in) prices on bills.',
  },
  {
    value: 'composition',
    label: 'Composition scheme',
    description: 'You pay tax yourself; bills say “composition taxable person” and add no GST.',
  },
] as const;

export function TaxForm({ settings, readOnly }: FormProps) {
  const ids = useId();
  const form = useForm({
    resolver: zodResolver(taxTabSchema),
    values: {
      gstMode: settings.gst_mode,
      gstRateBps: settings.gst_rate_bps,
      pricesIncludeTax: settings.prices_include_tax,
      serviceChargeEnabled: settings.service_charge_enabled,
      serviceChargePercent: bpsToPercent(settings.service_charge_bps),
      gstin: settings.gstin ?? '',
      fssaiLicense: settings.fssai_license ?? '',
    } satisfies TaxTab,
    resetOptions: FOLLOW_SERVER,
  });
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form;
  const save = useSave<TaxTab>('tax', form);
  const gstMode = useWatch({ control, name: 'gstMode' });
  const serviceChargeEnabled = useWatch({ control, name: 'serviceChargeEnabled' });
  const rateItems = GST_RATES_BPS.map((bps) => ({
    value: String(bps),
    label: `${bpsToPercent(bps)}%`,
  }));

  return (
    <form onSubmit={handleSubmit(save)} noValidate className="flex flex-col gap-5">
      <p className="rounded-md border-l-4 border-status-preparing bg-paper px-3 py-2 text-sm text-ink">
        Confirm these with your accountant. They apply to new bills only; past bills keep the
        settings they were made with.
      </p>
      <FieldGroup className="gap-5">
        <Field>
          <FieldLabel id={`${ids}-mode`}>GST</FieldLabel>
          <Controller
            control={control}
            name="gstMode"
            render={({ field }) => (
              <RadioGroup
                aria-labelledby={`${ids}-mode`}
                value={field.value}
                onValueChange={(value) => field.onChange(value)}
                disabled={readOnly}
                className="gap-3"
              >
                {GST_MODE_OPTIONS.map((option) => (
                  <label key={option.value} className="flex items-start gap-2 text-sm text-ink">
                    <RadioGroupItem value={option.value} className="mt-0.5" />
                    <span className="flex flex-col">
                      <span className="font-medium">{option.label}</span>
                      <span className="text-ink-muted">{option.description}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            )}
          />
        </Field>

        {gstMode === 'regular' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${ids}-rate`}>GST rate</FieldLabel>
              <Controller
                control={control}
                name="gstRateBps"
                render={({ field }) => (
                  <Select
                    items={rateItems}
                    value={String(field.value)}
                    onValueChange={(value) => field.onChange(Number(value))}
                    disabled={readOnly}
                  >
                    <SelectTrigger id={`${ids}-rate`} className="h-9 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {rateItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldDescription>Most restaurants charge 5%.</FieldDescription>
            </Field>
            <Controller
              control={control}
              name="pricesIncludeTax"
              render={({ field }) => (
                <SwitchField
                  id={`${ids}-inclusive`}
                  label="Menu prices include GST"
                  description="Off: GST is added on top of menu prices on the bill."
                  checked={field.value}
                  onChange={field.onChange}
                  disabled={readOnly}
                />
              )}
            />
          </div>
        )}

        {gstMode !== 'none' && (
          <Field data-invalid={errors.gstin ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-gstin`}>GSTIN</FieldLabel>
            <Input
              id={`${ids}-gstin`}
              className="h-9 w-64 font-mono uppercase"
              maxLength={15}
              disabled={readOnly}
              {...register('gstin')}
            />
            <FieldError errors={[errors.gstin]} />
          </Field>
        )}

        <div className="flex flex-col gap-3">
          <Controller
            control={control}
            name="serviceChargeEnabled"
            render={({ field }) => (
              <SwitchField
                id={`${ids}-service`}
                label="Service charge"
                description="Optional; the bill lets staff leave it off for a table."
                checked={field.value}
                onChange={field.onChange}
                disabled={readOnly}
              />
            )}
          />
          {serviceChargeEnabled && (
            <Field data-invalid={errors.serviceChargePercent ? true : undefined}>
              <FieldLabel htmlFor={`${ids}-service-rate`}>Service charge (%)</FieldLabel>
              <Input
                id={`${ids}-service-rate`}
                inputMode="decimal"
                className="h-9 w-28 text-right tabular-nums"
                disabled={readOnly}
                {...register('serviceChargePercent')}
              />
              <FieldError errors={[errors.serviceChargePercent]} />
            </Field>
          )}
        </div>

        <Field data-invalid={errors.fssaiLicense ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-fssai`}>FSSAI licence number (optional)</FieldLabel>
          <Input
            id={`${ids}-fssai`}
            inputMode="numeric"
            maxLength={14}
            className="h-9 w-64 font-mono"
            disabled={readOnly}
            {...register('fssaiLicense')}
          />
          <FieldDescription>Printed on bills when set.</FieldDescription>
          <FieldError errors={[errors.fssaiLicense]} />
        </Field>
      </FieldGroup>
      <SaveBar pending={isSubmitting} readOnly={readOnly} error={errors.root?.message} />
    </form>
  );
}

// ─── Bill ───────────────────────────────────────────────────────────────────
export function BillForm({
  settings,
  readOnly,
  canShowUpiQr,
  upgradeHint,
}: FormProps & { canShowUpiQr: boolean; upgradeHint: string }) {
  const ids = useId();
  const form = useForm({
    resolver: zodResolver(billTabSchema),
    values: {
      invoicePrefix: settings.invoice_prefix,
      paperWidth: settings.paper_width,
      billFooterText: settings.bill_footer_text ?? '',
      printWaiterOnBill: settings.print_waiter_on_bill,
      showUpiQrOnBill: settings.show_upi_qr_on_bill,
      upiVpa: settings.upi_vpa ?? '',
      upiPayeeName: settings.upi_payee_name ?? '',
    } satisfies BillTab,
    resetOptions: FOLLOW_SERVER,
  });
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form;
  const save = useSave<BillTab>('bill', form);
  const prefix = useWatch({ control, name: 'invoicePrefix' });
  const vpa = useWatch({ control, name: 'upiVpa' });
  const payeeName = useWatch({ control, name: 'upiPayeeName' });
  // A plan without the feature can still switch it off, never on.
  const upiLocked = !canShowUpiQr && !settings.show_upi_qr_on_bill;

  return (
    <form onSubmit={handleSubmit(save)} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={errors.invoicePrefix ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-prefix`}>Invoice prefix</FieldLabel>
            <Input
              id={`${ids}-prefix`}
              className="h-9 w-40 font-mono"
              maxLength={10}
              disabled={readOnly}
              {...register('invoicePrefix')}
            />
            <FieldDescription>
              New bills are numbered like {prefix?.trim() || 'INV'}/2026-27/00001.
            </FieldDescription>
            <FieldError errors={[errors.invoicePrefix]} />
          </Field>
          <Field>
            <FieldLabel id={`${ids}-paper`}>Printer paper</FieldLabel>
            <Controller
              control={control}
              name="paperWidth"
              render={({ field }) => (
                <RadioGroup
                  aria-labelledby={`${ids}-paper`}
                  value={field.value}
                  onValueChange={(value) => field.onChange(value)}
                  disabled={readOnly}
                  className="flex h-9 items-center gap-6"
                >
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <RadioGroupItem value="80mm" /> 80 mm
                  </label>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <RadioGroupItem value="58mm" /> 58 mm
                  </label>
                </RadioGroup>
              )}
            />
          </Field>
        </div>

        <Field data-invalid={errors.billFooterText ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-footer`}>Footer text (optional)</FieldLabel>
          <Textarea
            id={`${ids}-footer`}
            rows={2}
            maxLength={200}
            placeholder="Thank you, visit again!"
            disabled={readOnly}
            {...register('billFooterText')}
          />
          <FieldError errors={[errors.billFooterText]} />
        </Field>

        <Controller
          control={control}
          name="printWaiterOnBill"
          render={({ field }) => (
            <SwitchField
              id={`${ids}-waiter`}
              label="Print the waiter's name on bills"
              checked={field.value}
              onChange={field.onChange}
              disabled={readOnly}
            />
          )}
        />

        <fieldset className="flex flex-col gap-4 rounded-md border border-line p-4">
          <legend className="px-1 text-sm font-medium text-ink">UPI QR on bills</legend>
          <Controller
            control={control}
            name="showUpiQrOnBill"
            render={({ field }) => (
              <SwitchField
                id={`${ids}-upi`}
                label="Print a UPI QR so guests can pay by scanning"
                checked={field.value}
                onChange={field.onChange}
                disabled={readOnly || upiLocked}
                hint={upiLocked ? upgradeHint : undefined}
              />
            )}
          />
          <FieldError errors={[errors.showUpiQrOnBill]} />
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto]">
            <Field data-invalid={errors.upiVpa ? true : undefined}>
              <FieldLabel htmlFor={`${ids}-vpa`}>UPI ID</FieldLabel>
              <Input
                id={`${ids}-vpa`}
                className="h-9 font-mono"
                placeholder="restaurant@okicici"
                autoCapitalize="none"
                spellCheck={false}
                disabled={readOnly}
                {...register('upiVpa')}
              />
              <FieldError errors={[errors.upiVpa]} />
            </Field>
            <Field data-invalid={errors.upiPayeeName ? true : undefined}>
              <FieldLabel htmlFor={`${ids}-payee`}>Payee name (optional)</FieldLabel>
              <Input
                id={`${ids}-payee`}
                className="h-9"
                maxLength={80}
                disabled={readOnly}
                {...register('upiPayeeName')}
              />
              <FieldError errors={[errors.upiPayeeName]} />
            </Field>
            <UpiPreview vpa={vpa ?? ''} payeeName={payeeName ?? ''} />
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-4">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-ink">Test print</p>
            <p className="text-sm text-ink-muted">
              Print a sample bill with the saved settings to check the printer and paper width.
            </p>
          </div>
          <a
            href="/admin/settings/test-print"
            target="_blank"
            rel="noopener"
            className={buttonVariants({ variant: 'outline', size: 'lg' })}
          >
            <Printer aria-hidden /> Test print
          </a>
        </div>
      </FieldGroup>
      <SaveBar pending={isSubmitting} readOnly={readOnly} error={errors.root?.message} />
    </form>
  );
}

/** Live test preview of the UPI QR (spec §13.3 Bill settings). */
function UpiPreview({ vpa, payeeName }: { vpa: string; payeeName: string }) {
  const [qr, setQr] = useState<{ key: string; src: string } | null>(null);
  const valid = UPI_VPA_PATTERN.test(vpa.trim());
  const url = valid ? buildUpiUrl({ vpa, payeeName }) : null;

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 240 }).then((src) => {
      if (!cancelled) setQr({ key: url, src });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const src = qr && qr.key === url ? qr.src : null;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="theme-light flex size-24 items-center justify-center rounded-md border border-line bg-white">
        {src ? (
          <Image
            src={src}
            alt={`UPI QR preview for ${vpa.trim()}`}
            width={96}
            height={96}
            unoptimized
            className="size-24"
          />
        ) : (
          <span className="px-2 text-center text-xs text-ink-muted">Enter a UPI ID to preview</span>
        )}
      </div>
      <span className="text-xs text-ink-muted">Scan to test</span>
    </div>
  );
}

// ─── Ordering ───────────────────────────────────────────────────────────────
function hourLabel(hour: number) {
  const suffix = hour < 12 ? 'am' : 'pm';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:00 ${suffix}`;
}

export function OrderingForm({ settings, readOnly }: FormProps) {
  const ids = useId();
  const form = useForm({
    resolver: zodResolver(orderingTabSchema),
    values: {
      requireFirstOrderApproval: settings.require_first_order_approval,
      customerCancelWindowSeconds: settings.customer_cancel_window_seconds,
      reopenWindowMinutes: settings.reopen_window_minutes,
      businessDayStartHour: settings.business_day_start_hour,
      maxTablesPerWaiter: settings.max_tables_per_waiter,
      staffCanRemoveServedItems: settings.staff_can_remove_served_items,
    } satisfies OrderingTab,
    resetOptions: FOLLOW_SERVER,
  });
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form;
  const save = useSave<OrderingTab>('ordering', form);
  const hourItems = Array.from({ length: 24 }, (_, hour) => ({
    value: String(hour),
    label: hourLabel(hour),
  }));
  const number = (
    name: 'customerCancelWindowSeconds' | 'reopenWindowMinutes' | 'maxTablesPerWaiter',
    label: string,
    description: string,
    unit: string,
  ) => (
    <Field data-invalid={errors[name] ? true : undefined}>
      <FieldLabel htmlFor={`${ids}-${name}`}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={`${ids}-${name}`}
          type="number"
          inputMode="numeric"
          className="h-9 w-24 text-right tabular-nums"
          disabled={readOnly}
          {...register(name, { valueAsNumber: true })}
        />
        <span className="text-sm text-ink-muted">{unit}</span>
      </div>
      <FieldDescription>{description}</FieldDescription>
      <FieldError errors={[errors[name]]} />
    </Field>
  );

  return (
    <form onSubmit={handleSubmit(save)} noValidate className="flex flex-col gap-5">
      <FieldGroup className="gap-5">
        <Controller
          control={control}
          name="requireFirstOrderApproval"
          render={({ field }) => (
            <SwitchField
              id={`${ids}-approval`}
              label="Staff approve each table's first order"
              description="Stops prank orders: the kitchen only sees a new table once a waiter or manager confirms it."
              checked={field.value}
              onChange={field.onChange}
              disabled={readOnly}
            />
          )}
        />
        <div className="grid gap-5 sm:grid-cols-2">
          {number(
            'customerCancelWindowSeconds',
            'Customer cancel window',
            'How long customers can cancel a dish the kitchen hasn’t started (0–600).',
            'seconds',
          )}
          {number(
            'reopenWindowMinutes',
            'Reopen window after a bill',
            'How long after a bill a manager can void it and reopen the table (0–120).',
            'minutes',
          )}
          <Field data-invalid={errors.businessDayStartHour ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-day-start`}>Business day starts at</FieldLabel>
            <Controller
              control={control}
              name="businessDayStartHour"
              render={({ field }) => (
                <Select
                  items={hourItems}
                  value={String(field.value)}
                  onValueChange={(value) => field.onChange(Number(value))}
                  disabled={readOnly}
                >
                  <SelectTrigger id={`${ids}-day-start`} className="h-9 w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {hourItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <FieldDescription>
              Orders after midnight count towards the previous day until this hour.
            </FieldDescription>
            <FieldError errors={[errors.businessDayStartHour]} />
          </Field>
          {number(
            'maxTablesPerWaiter',
            'Tables per waiter',
            'A waiter handling this many tables shows as busy (1–20).',
            'tables',
          )}
        </div>
        <Controller
          control={control}
          name="staffCanRemoveServedItems"
          render={({ field }) => (
            <SwitchField
              id={`${ids}-remove-served`}
              label="Worker panel staff can remove served dishes"
              description="Off: only managers and owners remove a dish once it has been served."
              checked={field.value}
              onChange={field.onChange}
              disabled={readOnly}
            />
          )}
        />
      </FieldGroup>
      <SaveBar pending={isSubmitting} readOnly={readOnly} error={errors.root?.message} />
    </form>
  );
}
