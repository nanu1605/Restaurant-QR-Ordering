import { readRestaurantFilters } from '@/features/platform/params';
import { todayInIndia } from '@/features/platform/platform';
import { listRestaurants } from '@/features/platform/queries';
import { restaurantsCsv } from '@/features/platform/restaurants-csv';
import { toCsv } from '@/features/reports/csv';
import { requirePlatformPermission } from '@/lib/auth/guards';

/**
 * The restaurants list as a CSV, with the page's filters and sort
 * (docs/DECISIONS.md SA-23).
 */
export async function GET(request: Request) {
  await requirePlatformPermission('restaurants.view');
  const url = new URL(request.url);
  const filters = readRestaurantFilters(Object.fromEntries(url.searchParams));
  const list = await listRestaurants(filters, true);
  if (list.total > list.rows.length) {
    return new Response('Too many restaurants for one file: filter the list first.', {
      status: 413,
    });
  }
  return new Response(toCsv(restaurantsCsv(list.rows)), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="restaurants-${todayInIndia()}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
