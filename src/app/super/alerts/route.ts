import { getAlerts } from '@/features/platform/queries';
import { getPlatformAdminStatus } from '@/lib/auth/session';

const noStore = { 'Cache-Control': 'private, no-store' };

/**
 * What the alerts bell asks for every minute (docs/DECISIONS.md SA-30). A
 * signed-out or second-factor-less request gets 401 rather than a redirect.
 */
export async function GET() {
  if ((await getPlatformAdminStatus()) !== 'ok') {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: noStore });
  }
  try {
    return Response.json(await getAlerts(), { headers: noStore });
  } catch (error) {
    console.error('[super/alerts] could not load', error);
    return Response.json({ error: 'Unavailable' }, { status: 503, headers: noStore });
  }
}
