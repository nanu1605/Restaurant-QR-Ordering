/**
 * The MenuMesh mark (docs/DECISIONS.md B-1): a white "M" in an orange hexagon,
 * from the logo's SVG. The website, panels and app icons all draw it from here.
 */
export const LOGO_VIEWBOX = '0 0 306 342';
export const LOGO_ORANGE = '#FF6606';
export const LOGO_HEXAGON =
  'M134.793 4.80547C145.89 -1.60182 159.563 -1.60182 170.661 4.80547L287.519 72.2736C298.617 78.6809 305.454 90.5221 305.454 103.337V238.273C305.454 251.088 298.617 262.929 287.519 269.336L170.661 336.804C159.563 343.211 145.89 343.211 134.793 336.804L17.9343 269.336C6.83651 262.929 0 251.088 0 238.273V103.337C0 90.5221 6.83651 78.6809 17.9343 72.2736L134.793 4.80547Z';
export const LOGO_M =
  'M231.682 90.2697C249.932 79.826 272.787 92.9873 272.787 114.139V222.219C272.787 234.468 262.857 244.399 250.609 244.399C238.36 244.399 228.43 234.468 228.43 222.219V143.819L175.154 175.523V278.15C175.154 290.4 165.225 300.33 152.976 300.33C140.727 300.33 130.798 290.4 130.798 278.15V175.765L77.5216 144.06V222.46C77.5216 234.709 67.5921 244.64 55.3433 244.64C43.0946 244.64 33.165 234.709 33.165 222.46V114.38C33.1651 93.2284 56.0201 80.0671 74.27 90.5107L74.7004 90.7617L152.773 137.223L231.252 90.5206L231.682 90.2697Z';

/**
 * The app icon drawn for next/og (docs/DECISIONS.md P9-6, B-1). Plain: the
 * hexagon on a transparent square, for browser tabs. Padded: the hexagon in the
 * middle 64% of a white square, inside a maskable icon's safe circle and opaque
 * for iOS home screens.
 */
export function AppIcon({ size, padded = false }: { size: number; padded?: boolean }) {
  const height = Math.round(size * (padded ? 0.64 : 0.96));
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: padded ? '#FFFFFF' : 'transparent',
      }}
    >
      <svg width={Math.round((height * 306) / 342)} height={height} viewBox={LOGO_VIEWBOX}>
        <path d={LOGO_HEXAGON} fill={LOGO_ORANGE} />
        <path d={LOGO_M} fill="#FFFFFF" />
      </svg>
    </div>
  );
}
