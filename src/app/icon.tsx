import { ImageResponse } from 'next/og';

import { AppIcon } from '@/lib/app-icon';

/** Icons for browsers and the install manifest (docs/DECISIONS.md P9-6): /icon/192, /icon/512. */
const SIZES = [192, 512];

export function generateImageMetadata() {
  return SIZES.map((size) => ({
    id: String(size),
    size: { width: size, height: size },
    contentType: 'image/png',
  }));
}

export default async function Icon({ id }: { id: Promise<string> }) {
  const size = Number(await id);
  return new ImageResponse(<AppIcon />, { width: size, height: size });
}
