import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { VerifyForm } from '@/features/site/components/verify-form';
import { SITE } from '@/features/site/content';
import { fillNodes } from '@/features/site/i18n';
import { signupIdFromCookie } from '@/features/site/signup';
import { createAdminClient } from '@/lib/supabase/admin';

export const metadata: Metadata = {
  title: SITE.en.verify.meta.title,
  robots: { index: false },
};

/** Step 2 of the self-serve signup (docs/DECISIONS.md W-9): the code from the email. */
export default async function VerifyPage() {
  const t = SITE.en.verify;
  const id = await signupIdFromCookie();
  const { data: signup } = id
    ? await createAdminClient()
        .from('site_signups')
        .select('email, details, verified_at')
        .eq('id', id)
        .maybeSingle()
    : { data: null };
  if (!signup || signup.verified_at) redirect('/signup');

  // Starting again keeps the plan chosen on /pricing.
  const { planCode, cycle } = signup.details as { planCode?: string | null; cycle?: string };
  const restart = new URLSearchParams();
  if (planCode) restart.set('plan', planCode);
  if (cycle === 'yearly') restart.set('cycle', cycle);
  const restartHref = restart.size > 0 ? `/signup?${restart}` : '/signup';

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-8 px-4 py-12 sm:px-6 sm:py-16">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">{t.title}</h1>
        <p className="text-base text-ink-muted sm:text-lg">
          {fillNodes(t.sent, {
            email: <strong className="break-all text-ink">{signup.email}</strong>,
          })}
        </p>
      </div>
      <VerifyForm restartHref={restartHref} />
    </div>
  );
}
