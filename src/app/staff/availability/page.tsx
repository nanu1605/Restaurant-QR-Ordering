import type { Metadata } from 'next';

import { AvailabilityList } from '@/features/orders/components/availability-list';
import { staffStrings } from '@/features/orders/staff-strings';
import { requireMember } from '@/lib/auth/guards';
import { STAFF_PANEL_ROLES } from '@/lib/auth/roles';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await staffStrings()).nav.availability };
}

export default async function AvailabilityPage() {
  await requireMember(STAFF_PANEL_ROLES);
  return <AvailabilityList />;
}
