import type { Metadata } from 'next';
import { Suspense } from 'react';

import { PageHeader } from '@/components/shared/page-header';
import { EmailLookup } from '@/features/system/components/email-lookup';
import { SentrySection, VersionsSection } from '@/features/system/components/external-checks';
import {
  EmailSection,
  JobsSection,
  MenuImportsSection,
  Section,
  SpaceSection,
  WebhooksSection,
} from '@/features/system/components/system-sections';
import { getSystem } from '@/features/system/queries';
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/auth/guards';
import { emailConfig } from '@/lib/email/resend';
import { getServerEnv } from '@/lib/env.server';

export const metadata: Metadata = {
  title: 'System health',
};

function Loading({ id, title }: { id: string; title: string }) {
  return (
    <Section id={id} title={title}>
      <p className="text-sm text-ink-muted">Checking…</p>
    </Section>
  );
}

/**
 * System health (docs/SUPER_ADMIN_PLAN.md 14d, docs/DECISIONS.md SA-86+):
 * scheduled jobs, webhooks, email, errors, space, menu imports and versions.
 * Sentry and the deployments stream in after the rest.
 */
export default async function SuperSystemPage() {
  await requirePlatformPermission('system.view');
  const [system, canEditLimits] = await Promise.all([
    getSystem(),
    hasPlatformPermission('settings.manage'),
  ]);

  return (
    <>
      <PageHeader
        title="System health"
        description="Scheduled jobs, webhooks, email, errors and space. Times are India time."
      />
      <JobsSection system={system} />
      <WebhooksSection webhooks={system.webhooks} />
      <EmailSection
        email={system.email}
        configured={emailConfig() !== null}
        bounces={Boolean(getServerEnv().RESEND_WEBHOOK_SECRET)}
        lookup={<EmailLookup />}
      />
      <Suspense fallback={<Loading id="errors-heading" title="Errors" />}>
        <SentrySection />
      </Suspense>
      <SpaceSection sizes={system.sizes} canEditLimits={canEditLimits} />
      <MenuImportsSection imports={system.menu_imports} />
      <Suspense fallback={<Loading id="versions-heading" title="Versions" />}>
        <VersionsSection />
      </Suspense>
    </>
  );
}
