import { Mail, MessageCircle, Phone } from 'lucide-react';
import type { Metadata } from 'next';

import { ContactForm } from '@/features/site/components/contact-form';
import { getSitePricing } from '@/features/site/queries';
import { firstParam } from '@/lib/date-range';
import { turnstileConfig } from '@/lib/turnstile';

export const metadata: Metadata = {
  title: 'Book a demo',
  description: 'Talk to us about QR ordering, kitchen screens and billing for your restaurant.',
};

const WAYS = [
  { icon: Mail, title: 'Email', detail: '[Support email]' },
  { icon: Phone, title: 'Phone', detail: '[Phone number and hours]' },
  { icon: MessageCircle, title: 'WhatsApp', detail: '[WhatsApp number]' },
];

/** The plans for the form's menu; the form still works if they can't be read. */
async function planChoices() {
  try {
    return (await getSitePricing()).plans.map(({ code, name }) => ({ code, name }));
  } catch (error) {
    console.error('[site] plans not loaded for the contact form:', error);
    return [];
  }
}

/**
 * "Book a demo": the form (docs/DECISIONS.md W-6) when Turnstile is set up,
 * and the contact details (placeholders until launch, W-2).
 */
export default async function ContactPage({ searchParams }: PageProps<'/contact'>) {
  const turnstile = turnstileConfig();
  const plans = turnstile ? await planChoices() : [];
  const requested = firstParam(await searchParams, 'plan');
  const defaultPlan = plans.some((plan) => plan.code === requested) ? requested : undefined;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-12 sm:px-6 sm:py-16">
      <div className="flex max-w-2xl flex-col gap-3">
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">Book a demo</h1>
        <p className="text-base text-ink-muted sm:text-lg">
          Tell us about your restaurant. We’ll show you MenuMesh on your own menu, set up your
          tables with you, and you can try MenuMesh free for 14 days on the Growth plan.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.6fr_1fr]">
        {turnstile && (
          <ContactForm siteKey={turnstile.siteKey} plans={plans} defaultPlan={defaultPlan} />
        )}
        <section aria-labelledby="ways-title" className="flex flex-col gap-4">
          <h2 id="ways-title" className="text-lg font-semibold text-ink">
            {turnstile ? 'Or reach us directly' : 'Reach us directly'}
          </h2>
          <p
            role="note"
            className="rounded-lg border border-attention/40 bg-attention/5 px-4 py-3 text-sm font-medium text-ink"
          >
            Placeholder — the contact details below are filled in before launch.
          </p>
          <ul
            className={turnstile ? 'flex flex-col gap-3' : 'grid grid-cols-1 gap-4 sm:grid-cols-3'}
          >
            {WAYS.map(({ icon: Icon, title, detail }) => (
              <li
                key={title}
                className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-5"
              >
                <Icon aria-hidden className="size-6 shrink-0 text-brand" />
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-ink">{title}</h3>
                  <p className="text-sm text-ink-muted">{detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
