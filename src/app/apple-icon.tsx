import { ImageResponse } from 'next/og';

import { AppIcon } from '@/lib/app-icon';

/** The home screen icon on iPads and iPhones (docs/DECISIONS.md P9-6): opaque, so padded on white. */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(<AppIcon size={size.width} padded />, size);
}
