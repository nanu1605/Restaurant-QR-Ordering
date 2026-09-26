import { BRAND_COLOR } from './config';

/**
 * The app icon drawn for next/og (docs/DECISIONS.md P9-6): a white "M" on the
 * brand colour, inside the middle 60% so it also works as a maskable icon.
 */
export function AppIcon() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: BRAND_COLOR,
      }}
    >
      <svg width="60%" height="60%" viewBox="0 0 24 24">
        <path
          d="M4 19V5l8 9 8-9v14"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
