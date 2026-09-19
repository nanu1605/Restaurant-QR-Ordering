import { Building2 } from 'lucide-react';
import type { Metadata } from 'next';

import { EmptyState } from '@/components/shared/empty-state';
import { requirePlatformAdmin } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Platform admin',
};

export default async function SuperHomePage() {
  await requirePlatformAdmin();

  return (
    <EmptyState
      icon={Building2}
      title="Restaurants will be managed here"
      description="Until the onboarding wizard is ready, add restaurants with pnpm create-restaurant."
      className="flex-1"
    />
  );
}
