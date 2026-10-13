import type { Metadata } from 'next';

import { LiveBoard } from '@/features/orders/components/live-board';
import { staffStrings } from '@/features/orders/staff-strings';
import { requireMember } from '@/lib/auth/guards';
import { STAFF_PANEL_ROLES } from '@/lib/auth/roles';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await staffStrings()).nav.board };
}

export default async function StaffBoardPage() {
  await requireMember(STAFF_PANEL_ROLES);
  return <LiveBoard mode="staff" />;
}
