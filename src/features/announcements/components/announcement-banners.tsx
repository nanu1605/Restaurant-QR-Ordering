import { cn } from 'cn';

import { Button } from '@/components/ui/button';
import type { Lang } from '@/features/ordering/strings';

import { dismissAnnouncement } from '../actions';
import { bannerText, type Panel } from '../announcements';
import { getBanners } from '../queries';
import { AnnouncementBanner } from './announcement-banner';

/** The announcements this login sees now in a panel, each with Dismiss when allowed. */
export async function AnnouncementBanners({
  restaurantId,
  panel,
  lang = 'en',
  dismissLabel = 'Dismiss',
  className,
}: {
  restaurantId: string;
  panel: Panel;
  lang?: Lang;
  dismissLabel?: string;
  className?: string;
}) {
  const banners = await getBanners(restaurantId, panel);
  if (banners.length === 0) return null;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {banners.map((banner) => (
        <AnnouncementBanner key={banner.id} {...bannerText(banner, lang)}>
          {banner.dismissible && (
            <form action={dismissAnnouncement}>
              <input type="hidden" name="id" value={banner.id} />
              <Button type="submit" variant="outline" size="touch">
                {dismissLabel}
              </Button>
            </form>
          )}
        </AnnouncementBanner>
      ))}
    </div>
  );
}
