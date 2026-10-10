import { Mail, MessageCircle, Phone, type LucideIcon } from 'lucide-react';

import { firstParam, type SearchParams } from '@/lib/date-range';
import { turnstileConfig } from '@/lib/turnstile';

import { ContactForm } from '../components/contact-form';
import { SITE, type SiteLang } from '../content';
import { getSitePricing } from '../queries';

/** By position in the dictionary's ways to reach us. */
const WAY_ICONS: LucideIcon[] = [Mail, Phone, MessageCircle];

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
export async function ContactView({
  lang,
  searchParams,
}: {
  lang: SiteLang;
  searchParams: Promise<SearchParams>;
}) {
  const t = SITE[lang].contact;
  const turnstile = turnstileConfig();
  const plans = turnstile ? await planChoices() : [];
  const requested = firstParam(await searchParams, 'plan');
  const defaultPlan = plans.some((plan) => plan.code === requested) ? requested : undefined;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-12 sm:px-6 sm:py-16">
      <div className="flex max-w-2xl flex-col gap-3">
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">{t.title}</h1>
        <p className="text-base text-ink-muted sm:text-lg">{t.lead}</p>
      </div>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.6fr_1fr]">
        {turnstile && (
          <ContactForm siteKey={turnstile.siteKey} plans={plans} defaultPlan={defaultPlan} />
        )}
        <section aria-labelledby="ways-title" className="flex flex-col gap-4">
          <h2 id="ways-title" className="text-lg font-semibold text-ink">
            {turnstile ? t.reachUs.withForm : t.reachUs.alone}
          </h2>
          <p
            role="note"
            className="rounded-lg border border-attention/40 bg-attention/5 px-4 py-3 text-sm font-medium text-ink"
          >
            {t.placeholder}
          </p>
          <ul
            className={turnstile ? 'flex flex-col gap-3' : 'grid grid-cols-1 gap-4 sm:grid-cols-3'}
          >
            {t.ways.map(({ title, detail }, index) => {
              const Icon = WAY_ICONS[index]!;
              return (
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
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
