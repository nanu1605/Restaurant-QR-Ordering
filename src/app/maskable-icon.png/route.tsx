import { ImageResponse } from 'next/og';

import { AppIcon } from '@/lib/app-icon';

/**
 * The install manifest's maskable icon (docs/DECISIONS.md B-1): the mark
 * padded on white, so launchers can crop it to any shape. A route of its own,
 * not an icon.tsx size, so pages don't offer it as their tab icon.
 */
export const dynamic = 'force-static';

export function GET() {
  return new ImageResponse(<AppIcon size={512} padded />, { width: 512, height: 512 });
}
