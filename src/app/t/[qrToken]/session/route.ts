import { readDeviceId } from '@/features/ordering/device';
import { getCustomerSession } from '@/features/ordering/queries';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * The orders page polls this every 10 s while visible (spec §12: customers
 * poll, they don't use Realtime).
 */
export async function GET(_request: Request, context: RouteContext<'/t/[qrToken]/session'>) {
  const { qrToken } = await context.params;
  const session = await getCustomerSession(qrToken, await readDeviceId());
  if (!session) {
    return Response.json({ error: 'TABLE_NOT_FOUND' }, { status: 404, headers: NO_STORE });
  }
  return Response.json(session, { headers: NO_STORE });
}
