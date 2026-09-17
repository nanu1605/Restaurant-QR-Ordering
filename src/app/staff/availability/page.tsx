import type { Metadata } from 'next';

import { AvailabilityList } from '@/features/orders/components/availability-list';
import { requireMember } from '@/lib/auth/guards';
import { STAFF_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Availability',
};

export default async function AvailabilityPage() {
  await requireMember(STAFF_PANEL_ROLES);
  return <AvailabilityList />;
}
