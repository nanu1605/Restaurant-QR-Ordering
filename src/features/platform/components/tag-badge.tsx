import type { Tag, TagColour } from '../platform';

// The swatch only: the name stays ink, so every colour reads in both themes
// (docs/DECISIONS.md SA-39).
export const TAG_SWATCHES: Record<TagColour, string> = {
  orange: 'var(--brand)',
  teal: 'var(--status-ready)',
  amber: 'var(--status-preparing)',
  green: 'var(--status-served)',
  red: 'var(--status-void)',
  slate: 'var(--status-placed)',
};

export function TagBadge({ tag }: { tag: Pick<Tag, 'name' | 'colour'> }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line bg-surface px-2 text-xs font-medium whitespace-nowrap text-ink">
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: TAG_SWATCHES[tag.colour] }}
      />
      {tag.name}
    </span>
  );
}
