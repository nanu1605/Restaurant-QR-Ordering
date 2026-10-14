'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ImagePlus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createClient } from '@/lib/supabase/browser';

import { createSupportRequest, startScreenshotUpload } from '../actions';
import {
  CONTACT_METHOD_LABELS,
  CONTACT_METHODS,
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_BUCKET,
  SCREENSHOT_TYPES,
  SUPPORT_TOPIC_LABELS,
  SUPPORT_TOPICS,
  supportRequestSchema,
  type ContactMethod,
  type SupportRequestFields,
  type SupportRequestInput,
} from '../support';

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-input bg-surface px-2.5 text-base text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:h-9 md:text-sm';

type Props = {
  /** The page the account menu was opened on, sent along as context. */
  from: string | null;
  phone: string | null;
  email: string | null;
};

/**
 * Get help (docs/DECISIONS.md SA-42): what it is about, the message, an
 * optional screenshot and how to reach the person asking.
 */
export function GetHelpForm({ from, phone, email }: Props) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [screenshot, setScreenshot] = useState<{ file: File; preview: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const form = useForm<SupportRequestFields, unknown, SupportRequestInput>({
    resolver: zodResolver(supportRequestSchema),
    defaultValues: { topic: '', message: '', contact_method: 'call', contact: phone ?? '' },
  });
  const { errors, isSubmitting } = form.formState;
  const method = useWatch({ control: form.control, name: 'contact_method' });

  useEffect(
    () => () => {
      if (screenshot) URL.revokeObjectURL(screenshot.preview);
    },
    [screenshot],
  );

  // The usual address for the way chosen, unless one was typed.
  function chooseMethod(next: ContactMethod) {
    const contact = form.getValues('contact');
    const usual = (value: ContactMethod) => (value === 'email' ? email : phone) ?? '';
    form.setValue('contact_method', next);
    if (contact === '' || contact === usual(method)) form.setValue('contact', usual(next));
  }

  function pick(file: File | undefined) {
    setFileError(null);
    if (!file) return;
    if (!(file.type in SCREENSHOT_TYPES)) {
      setFileError('Choose a PNG, JPEG or WebP image.');
    } else if (file.size > MAX_SCREENSHOT_BYTES) {
      setFileError('Choose an image under 5 MB.');
    } else {
      setScreenshot({ file, preview: URL.createObjectURL(file) });
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  async function submit(values: SupportRequestInput) {
    let screenshotPath: string | null = null;
    if (screenshot) {
      setStatus('Uploading the screenshot…');
      const started = await startScreenshotUpload(screenshot.file.type);
      if (!started.ok) {
        setStatus(null);
        form.setError('root', { message: started.error });
        return;
      }
      const { error } = await createClient()
        .storage.from(SCREENSHOT_BUCKET)
        .uploadToSignedUrl(started.data.path, started.data.token, screenshot.file, {
          contentType: screenshot.file.type,
        });
      if (error) {
        setStatus(null);
        form.setError('root', {
          message: 'The screenshot did not upload. Check the connection and try again.',
        });
        return;
      }
      screenshotPath = started.data.path;
    }
    setStatus('Sending…');
    const result = await createSupportRequest({ ...values, screenshotPath, from });
    setStatus(null);
    if (!result.ok) {
      const field = (['topic', 'message', 'contact_method', 'contact'] as const).find(
        (name) => result.fieldErrors?.[name],
      );
      form.setError(field ?? 'root', {
        message: (field && result.fieldErrors?.[field]) ?? result.error,
      });
      return;
    }
    toast.success('Sent. The MenuMesh team will get back to you.');
    form.reset({
      topic: '',
      message: '',
      contact_method: values.contact_method,
      contact: values.contact,
    });
    setScreenshot(null);
  }

  return (
    <form onSubmit={form.handleSubmit(submit)} noValidate className="flex flex-col gap-4">
      <Field data-invalid={errors.topic ? true : undefined}>
        <FieldLabel htmlFor={`${id}-topic`}>What is it about?</FieldLabel>
        <select
          id={`${id}-topic`}
          className={SELECT_CLASS}
          aria-invalid={!!errors.topic}
          {...form.register('topic')}
        >
          <option value="" disabled>
            Choose one
          </option>
          {SUPPORT_TOPICS.map((topic) => (
            <option key={topic} value={topic}>
              {SUPPORT_TOPIC_LABELS[topic]}
            </option>
          ))}
        </select>
        <FieldError errors={[errors.topic]} />
      </Field>

      <Field data-invalid={errors.message ? true : undefined}>
        <FieldLabel htmlFor={`${id}-message`}>What do you need help with?</FieldLabel>
        <Textarea
          id={`${id}-message`}
          rows={5}
          maxLength={2000}
          aria-invalid={!!errors.message}
          {...form.register('message')}
        />
        <FieldDescription>
          What you tried and what happened helps us fix it faster.
        </FieldDescription>
        <FieldError errors={[errors.message]} />
      </Field>

      <div className="flex flex-col gap-2">
        <span id={`${id}-shot`} className="text-sm font-medium text-ink">
          Screenshot (optional)
        </span>
        {screenshot ? (
          <div className="flex flex-wrap items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local preview, not a served image */}
            <img
              src={screenshot.preview}
              alt="The screenshot to send"
              className="max-h-40 max-w-full rounded-md border border-line object-contain"
            />
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={() => setScreenshot(null)}
            >
              <X aria-hidden /> Remove screenshot
            </Button>
          </div>
        ) : (
          <>
            <input
              ref={fileRef}
              id={`${id}-file`}
              type="file"
              accept={Object.keys(SCREENSHOT_TYPES).join(',')}
              className="sr-only"
              aria-labelledby={`${id}-shot`}
              aria-describedby={`${id}-shot-hint`}
              onChange={(event) => pick(event.target.files?.[0])}
            />
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="w-fit"
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus aria-hidden /> Add a screenshot
            </Button>
          </>
        )}
        <p id={`${id}-shot-hint`} className="text-sm text-ink-muted">
          A PNG, JPEG or WebP image up to 5 MB. Only the MenuMesh team sees it.
        </p>
        {fileError && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {fileError}
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-ink">How should we reach you?</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {CONTACT_METHODS.map((option) => (
            <label
              key={option}
              className="flex min-h-11 items-center gap-2 text-sm text-ink md:min-h-9"
            >
              <input
                type="radio"
                name={`${id}-method`}
                value={option}
                checked={method === option}
                onChange={() => chooseMethod(option)}
                className="size-4 accent-brand"
              />
              {CONTACT_METHOD_LABELS[option]}
            </label>
          ))}
        </div>
        <Field data-invalid={errors.contact ? true : undefined}>
          <FieldLabel htmlFor={`${id}-contact`}>
            {method === 'email' ? 'Email address' : 'Mobile number'}
          </FieldLabel>
          <Input
            id={`${id}-contact`}
            type={method === 'email' ? 'email' : 'tel'}
            inputMode={method === 'email' ? 'email' : 'tel'}
            autoComplete={method === 'email' ? 'email' : 'tel'}
            className="h-11 md:h-9"
            aria-invalid={!!errors.contact}
            {...form.register('contact')}
          />
          <FieldError errors={[errors.contact]} />
        </Field>
      </fieldset>

      {errors.root && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errors.root.message}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {status && (
          <p role="status" className="text-sm text-ink-muted">
            {status}
          </p>
        )}
        <Button type="submit" size="touch" disabled={isSubmitting}>
          {isSubmitting ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </form>
  );
}
