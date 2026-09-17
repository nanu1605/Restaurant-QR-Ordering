import type { Metadata } from 'next';

import { LiveBoard } from '@/features/orders/components/live-board';
import { requireMember } from '@/lib/auth/guards';
import { STAFF_PANEL_ROLES } from '@/lib/auth/roles';

export const metadata: Metadata = {
  title: 'Board',
};

export default async function StaffBoardPage() {
  await requireMember(STAFF_PANEL_ROLES);
  return <LiveBoard mode="staff" />;
}
