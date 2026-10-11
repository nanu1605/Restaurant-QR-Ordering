import { Check } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Money } from '@/components/shared/money';
import { firstParam, type SearchParams } from '@/lib/date-range';
import { turnstileConfig } from '@/lib/turnstile';

import { SignupForm } from '../components/signup-form';
import { SITE, type SiteLang } from '../content';
import { fill, fillNodes } from '../i18n';
import { getSitePricing } from '../queries';
import { signupOpen } from '../signup';

/** The chosen plan from /pricing, and the trial, for the page's summary. */
async function chosenPlan(code: string | undefined, cycle: 'monthly' | 'yearly') {
  try {
    const pricing = await getSitePricing();
    const plan = pricing.plans.find((candidate) => candidate.code === code) ?? null;
    return {
      trialDays: pricing.trialDays,
      plan: plan && {
        code: plan.code,
        name: plan.name,
        paise: cycle === 'yearly' ? plan.yearlyPaise : plan.monthlyPaise,
      },
    };
  } catch (error) {
    console.error('[site] plans not loaded for the signup page:', error);
    return { trialDays: null, plan: null };
  }
}

/** Step 1 of the self-serve signup (docs/DECISIONS.md W-9); without it, visitors book a demo. */
export async function SignupView({
  lang,
  searchParams,
}: {
  lang: SiteLang;
  searchParams: Promise<SearchParams>;
}) {
  const t = SITE[lang];
  const params = await searchParams;
  const requested = firstParam(params, 'plan');
  const turnstile = turnstileConfig();
  if (!turnstile || !signupOpen()) {
    // The plan and the campaign tags carry over to the demo request (W-13).
    const query = new URLSearchParams();
    for (const key of ['plan', 'utm_source', 'utm_medium', 'utm_campaign']) {
      const value = firstParam(params, key);
      if (value) query.set(key, value);
    }
    redirect(query.size ? `/contact?${query}` : '/contact');
  }
  const cycle = firstParam(params, 'cycle') === 'yearly' ? 'yearly' : 'monthly';
  const { trialDays, plan } = await chosenPlan(requested, cycle);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-12 sm:px-6 sm:py-16">
      <div className="flex max-w-2xl flex-col gap-3">
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">{t.signup.title}</h1>
        <p className="text-base text-ink-muted sm:text-lg">
          {t.signup.lead}
          {trialDays !== null && ` ${fill(t.signup.freeDays, { days: trialDays })}`}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.6fr_1fr]">
        <SignupForm
          t={{ ...t.form, ...t.signup.form, cuisines: t.labels.cuisines }}
          lang={lang}
          siteKey={turnstile.siteKey}
          planCode={plan?.code ?? ''}
          cycle={cycle}
        />
        <section aria-labelledby="perks-title" className="flex flex-col gap-4">
          <h2 id="perks-title" className="text-lg font-semibold text-ink">
            {t.signup.perksTitle}
          </h2>
          <ul className="flex flex-col gap-3 text-base text-ink">
            {t.signup.perks.map((perk) => (
              <li key={perk} className="flex items-start gap-2">
                <Check aria-hidden className="mt-1 size-4 shrink-0 text-status-served" />
                {perk}
              </li>
            ))}
          </ul>
          {plan && (
            <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink">
              {fillNodes(t.signup.afterTrial, {
                plan: plan.name,
                price: <Money paise={plan.paise} fraction="auto" className="font-semibold" />,
                per: t.per[cycle],
              })}
            </p>
          )}
          <p className="text-sm text-ink-muted">
            {fillNodes(t.signup.haveAccount, {
              login: (
                <Link href="/login" className="font-medium text-brand underline underline-offset-2">
                  {t.login}
                </Link>
              ),
            })}
          </p>
        </section>
      </div>
    </div>
  );
}
