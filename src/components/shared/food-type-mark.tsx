import { cn } from 'cn';

export type FoodType = 'veg' | 'non_veg' | 'egg';

const LABELS: Record<FoodType, string> = {
  veg: 'Vegetarian',
  non_veg: 'Non-vegetarian',
  egg: 'Contains egg',
};

const COLORS: Record<FoodType, string> = {
  veg: 'text-food-veg',
  non_veg: 'text-food-non-veg',
  egg: 'text-food-egg',
};

type FoodTypeMarkProps = {
  type: FoodType;
  size?: 'sm' | 'md';
  /** What the mark says to screen readers; English by default. */
  label?: string;
  className?: string;
};

/**
 * The standard Indian square food mark: outlined square with a filled
 * circle (veg), triangle (non-veg) or egg shape, on white in either theme.
 */
export function FoodTypeMark({
  type,
  size = 'md',
  label = LABELS[type],
  className,
}: FoodTypeMarkProps) {
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 20 20"
      data-food-type={type}
      className={cn(
        'shrink-0',
        size === 'sm' ? 'size-3.5' : 'size-[18px]',
        COLORS[type],
        className,
      )}
    >
      <title>{label}</title>
      <rect
        x="1.25"
        y="1.25"
        width="17.5"
        height="17.5"
        rx="2"
        fill="#fff"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      {type === 'veg' && <circle cx="10" cy="10" r="4.75" fill="currentColor" />}
      {type === 'non_veg' && <path d="M10 4.5 15.5 14.5H4.5Z" fill="currentColor" />}
      {type === 'egg' && <ellipse cx="10" cy="10.5" rx="4" ry="5" fill="currentColor" />}
    </svg>
  );
}
