'use client';

import { MessageCircle, Phone } from 'lucide-react';
import { useId, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

import { telHref, whatsappHref, type MessageLanguage } from '../dues-messages';

const LANGUAGES: { value: MessageLanguage; label: string; lang: string }[] = [
  { value: 'en', label: 'English', lang: 'en' },
  { value: 'hi', label: 'हिन्दी', lang: 'hi' },
];

/**
 * Call or WhatsApp a restaurant from the Dues page (docs/DECISIONS.md SA-20).
 * The message starts from the bucket's template and is edited before
 * WhatsApp opens with it.
 */
export function DuesContact({
  restaurantName,
  phone,
  messages,
}: {
  restaurantName: string;
  phone: string | null;
  messages: Record<MessageLanguage, string>;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState<MessageLanguage>('en');
  const [text, setText] = useState(messages.en);
  const tel = telHref(phone);
  const whatsapp = whatsappHref(phone, text);

  if (!tel) return <p className="text-sm text-ink-muted">No mobile number</p>;

  function choose(next: MessageLanguage) {
    setLanguage(next);
    setText(messages[next]);
  }

  return (
    <>
      <a
        href={tel}
        aria-label={`Call ${restaurantName}`}
        className={buttonVariants({ variant: 'outline', className: 'h-11 md:h-8' })}
      >
        <Phone aria-hidden />
        Call
      </a>
      <Button
        type="button"
        variant="outline"
        className="h-11 md:h-8"
        aria-label={`WhatsApp ${restaurantName}`}
        onClick={() => {
          choose('en');
          setOpen(true);
        }}
      >
        <MessageCircle aria-hidden />
        WhatsApp
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>WhatsApp {restaurantName}</DialogTitle>
            <DialogDescription>
              Edit the message, then open WhatsApp to send it. Nothing is sent from here.
            </DialogDescription>
          </DialogHeader>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium text-ink">Language</legend>
            <div className="flex gap-4">
              {LANGUAGES.map((option) => (
                <label
                  key={option.value}
                  lang={option.lang}
                  className="flex min-h-11 items-center gap-2 text-sm text-ink"
                >
                  <input
                    type="radio"
                    name={`${ids}-language`}
                    value={option.value}
                    checked={language === option.value}
                    onChange={() => choose(option.value)}
                    className="size-4 accent-brand"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
          <Field>
            <FieldLabel htmlFor={`${ids}-message`}>Message</FieldLabel>
            <Textarea
              id={`${ids}-message`}
              lang={language}
              rows={6}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" size="lg" />}>
              Cancel
            </DialogClose>
            {whatsapp && (
              <a
                href={whatsapp}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className={buttonVariants({ size: 'lg' })}
              >
                <MessageCircle aria-hidden />
                Open WhatsApp
              </a>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
