'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { attributionField } from '@/features/analytics/attribution';
import { CUISINE_SETS, DEFAULT_CUISINE } from '@/features/menu/default-categories';

import type { SiteContent, SiteLang } from '../content';
import { fillNodes } from '../i18n';
import { startSignup, type SignupFormState } from '../signup-actions';
import { Field, SELECT_CLASS } from './contact-form';
import { SiteLink } from './site-link';
import { TurnstileWidget } from './turnstile-widget';

type State = { result: SignupFormState; round: number };
type Photo = { blob: Blob; url: string };
type Words = SiteContent['form'] &
  SiteContent['signup']['form'] & { cuisines: SiteContent['labels']['cuisines'] };

const LINK_CLASS = 'font-semibold text-brand underline underline-offset-2';

/**
 * Step 1 of the self-serve signup (docs/DECISIONS.md W-9, P11-10 to P11-14); a success moves on
 * to /signup/verify. The photo is made a JPEG in the browser and kept here, so a refused form
 * doesn't lose it.
 */
export function SignupForm({
  t,
  lang,
  siteKey,
  planCode,
  cycle,
}: {
  t: Words;
  lang: SiteLang;
  siteKey: string;
  planCode: string;
  cycle: string;
}) {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [{ result, round }, action, pending] = useActionState(
    async (previous: State, formData: FormData): Promise<State> => {
      if (photo) formData.set('photo', photo.blob, 'storefront.jpg');
      return {
        result: await startSignup(previous.result, attributionField(formData)),
        round: previous.round + 1,
      };
    },
    { result: null, round: 0 },
  );
  const [checked, setChecked] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const cuisineId = useId();
  const termsId = useId();

  // After a refusal, focus the first field to fix (its message is linked to it).
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [result]);

  const value = (field: keyof NonNullable<SignupFormState>['values']) =>
    result?.values[field] ?? '';
  const error = (field: keyof NonNullable<SignupFormState>['values']) =>
    result?.fieldErrors?.[field];

  return (
    <form
      ref={form}
      action={action}
      noValidate
      aria-label={t.label}
      className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-4 sm:p-8"
    >
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="planCode" value={planCode} />
      <input type="hidden" name="cycle" value={cycle} />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field
          name="restaurantName"
          label={t.restaurantName}
          autoComplete="organization"
          defaultValue={value('restaurantName')}
          error={error('restaurantName')}
        />
        <Field
          name="city"
          label={t.city}
          autoComplete="address-level2"
          defaultValue={value('city')}
          error={error('city')}
        />
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={cuisineId}>{t.cuisine}</Label>
          <select
            key={value('cuisine')}
            id={cuisineId}
            name="cuisine"
            defaultValue={value('cuisine') || DEFAULT_CUISINE}
            aria-describedby={`${cuisineId}-hint`}
            className={SELECT_CLASS}
          >
            {CUISINE_SETS.map((cuisine) => (
              <option key={cuisine} value={cuisine}>
                {t.cuisines[cuisine]}
              </option>
            ))}
          </select>
          <p id={`${cuisineId}-hint`} className="text-sm text-ink-muted">
            {t.cuisineHint}
          </p>
        </div>
        <Field
          name="ownerName"
          label={t.name}
          autoComplete="name"
          defaultValue={value('ownerName')}
          error={error('ownerName')}
        />
        <Field
          name="email"
          label={t.email}
          type="email"
          autoComplete="email"
          defaultValue={value('email')}
          error={error('email')}
        />
        <Field
          name="phone"
          label={t.phone}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          defaultValue={value('phone')}
          error={error('phone')}
        />
        <div className="min-w-0 sm:col-span-2">
          <Field
            name="addressLine"
            label={t.address}
            autoComplete="street-address"
            defaultValue={value('addressLine')}
            error={error('addressLine')}
          />
        </div>
        <Field
          name="pincode"
          label={t.pincode}
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={6}
          defaultValue={value('pincode')}
          error={error('pincode')}
        />
        <Field
          name="fssaiLicense"
          label={t.fssai}
          hint={t.fssaiHint}
          inputMode="numeric"
          autoComplete="off"
          defaultValue={value('fssaiLicense')}
          error={error('fssaiLicense')}
        />
        <Field
          name="gstin"
          label={t.gstin}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          defaultValue={value('gstin')}
          error={error('gstin')}
        />
        <PhotoField t={t} photo={photo} onPhoto={setPhoto} error={result?.fieldErrors?.photo} />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-3">
          <input
            key={value('terms')}
            id={termsId}
            name="terms"
            type="checkbox"
            defaultChecked={value('terms') === 'on'}
            aria-invalid={error('terms') ? true : undefined}
            aria-describedby={error('terms') ? `${termsId}-error` : undefined}
            className="mt-0.5 size-5 shrink-0 accent-brand"
          />
          <Label htmlFor={termsId} className="text-base leading-snug font-normal">
            <span>
              {fillNodes(t.terms, {
                terms: (
                  <a
                    href="/terms"
                    target="_blank"
                    rel="noopener"
                    className="font-medium text-brand underline underline-offset-2"
                  >
                    {t.termsLink}
                    <span className="sr-only"> {t.newTab}</span>
                  </a>
                ),
                privacy: (
                  <a
                    href="/privacy"
                    target="_blank"
                    rel="noopener"
                    className="font-medium text-brand underline underline-offset-2"
                  >
                    {t.privacyLink}
                    <span className="sr-only"> {t.newTab}</span>
                  </a>
                ),
              })}
            </span>
          </Label>
        </div>
        {error('terms') && (
          <p id={`${termsId}-error`} className="text-sm text-status-void">
            {error('terms')}
          </p>
        )}
      </div>
      {/* Each submit renders a fresh check: tokens work once. */}
      <TurnstileWidget t={t} lang={lang} siteKey={siteKey} round={round} onReady={setChecked} />
      {result?.exists ? (
        <p role="alert" className="text-sm font-medium text-status-void">
          {fillNodes(t.exists, {
            login: (
              <SiteLink siteLang={lang} href="/login" className={LINK_CLASS}>
                {t.existsLogin}
              </SiteLink>
            ),
            contact: (
              <SiteLink siteLang={lang} href="/contact" className={LINK_CLASS}>
                {t.existsContact}
              </SiteLink>
            ),
          })}
        </p>
      ) : (
        result &&
        (result.error || result.fieldErrors) && (
          <p role="alert" className="text-sm font-medium text-status-void">
            {result.error ?? t.checkFields}
          </p>
        )
      )}
      <Button
        type="submit"
        size="touch"
        disabled={pending || !checked}
        className="sm:self-start sm:px-8"
      >
        {pending ? t.sending : t.submit}
      </Button>
      <p className="text-sm text-ink-muted">{checked ? t.note : t.waitForCheck}</p>
    </form>
  );
}

/**
 * The photo of the restaurant's front (P11-12): a JPEG of at most 1600 px made in the browser,
 * with the menu import's code, loaded only when a photo is picked.
 */
function PhotoField({
  t,
  photo,
  onPhoto,
  error,
}: {
  t: Words;
  photo: Photo | null;
  onPhoto: (photo: Photo | null) => void;
  error?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shownError = problem ?? error;

  // The preview's object URL goes with the photo it shows.
  useEffect(
    () => () => {
      if (photo) URL.revokeObjectURL(photo.url);
    },
    [photo],
  );

  async function pick(file: File | undefined) {
    if (!file) return;
    setPreparing(true);
    setProblem(null);
    try {
      const { preparePhoto, TOO_SMALL } = await import('@/features/menu-import/prepare-pages');
      try {
        const blob = await preparePhoto(file);
        onPhoto({ blob, url: URL.createObjectURL(blob) });
      } catch (prepError) {
        setProblem(
          prepError instanceof Error && prepError.message === TOO_SMALL
            ? t.photoSmall
            : t.photoUnreadable,
        );
      }
    } catch {
      setProblem(t.photoUnreadable);
    } finally {
      setPreparing(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      className="flex min-w-0 flex-col gap-1.5 sm:col-span-2"
    >
      <p id={`${id}-label`} className="text-sm leading-none font-medium">
        {t.photo}
      </p>
      <p id={`${id}-hint`} className="text-sm text-ink-muted">
        {t.photoHint}
      </p>
      {photo && (
        // eslint-disable-next-line @next/next/no-img-element -- a local preview (blob: URL)
        <img
          src={photo.url}
          alt={t.photoAlt}
          className="h-40 w-auto max-w-full self-start rounded-md border border-line object-cover"
        />
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        tabIndex={-1}
        aria-label={t.photo}
        className="sr-only"
        onChange={(event) => void pick(event.target.files?.[0])}
      />
      <Button
        type="button"
        variant="outline"
        size="touch"
        disabled={preparing}
        aria-invalid={shownError ? true : undefined}
        aria-describedby={[`${id}-hint`, shownError && `${id}-error`].filter(Boolean).join(' ')}
        className="self-start"
        onClick={() => input.current?.click()}
      >
        {preparing ? t.photoPreparing : photo ? t.photoChange : t.photoChoose}
      </Button>
      {shownError && (
        <p id={`${id}-error`} className="text-sm text-status-void">
          {shownError}
        </p>
      )}
    </div>
  );
}
