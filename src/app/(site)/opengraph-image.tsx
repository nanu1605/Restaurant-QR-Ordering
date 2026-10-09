import { ImageResponse } from 'next/og';

import { LOGO_HEXAGON, LOGO_M, LOGO_ORANGE, LOGO_VIEWBOX } from '@/lib/app-icon';
import { APP_NAME } from '@/lib/config';

/**
 * The website's link preview (docs/DECISIONS.md W-12): the logo, the name and one line, in fixed
 * English text on the light paper. Customer menus don't get it: their links are the restaurant's.
 */
export const alt = `${APP_NAME}: QR table ordering for restaurants`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 48,
        padding: 96,
        background: '#FAF8F5',
        color: '#1C1917',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 36 }}>
        <svg width={129} height={144} viewBox={LOGO_VIEWBOX}>
          <path d={LOGO_HEXAGON} fill={LOGO_ORANGE} />
          <path d={LOGO_M} fill="#FFFFFF" />
        </svg>
        <div style={{ fontSize: 104 }}>{APP_NAME}</div>
      </div>
      <div style={{ fontSize: 52, lineHeight: 1.3, maxWidth: 1000 }}>
        QR table ordering, kitchen and waiter screens, and billing for restaurants in India.
      </div>
    </div>,
    size,
  );
}
