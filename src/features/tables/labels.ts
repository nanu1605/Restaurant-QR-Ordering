/**
 * "Add tables" input (spec §13.3 Tables & QR): one table name, or a range.
 *   "5", "T5", "Terrace 2"   → one table
 *   "1-20", "1–20"           → 1, 2, … 20
 *   "T1-T5", "Terrace 1–4"   → T1 … T5, Terrace 1 … Terrace 4
 *   "01-12"                  → 01 … 12 (zero padding kept)
 */

export const MAX_TABLES_PER_ADD = 100;
export const MAX_LABEL_LENGTH = 30;

export type ParsedLabels = { ok: true; labels: string[] } | { ok: false; error: string };

const RANGE = /^(.*?)(\d+)\s*[-–—]\s*(.*?)(\d+)$/;

function tidy(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function parseTableLabels(input: string): ParsedLabels {
  const text = tidy(input);
  if (text === '') return { ok: false, error: 'Enter a table name or a range like 1–20.' };

  const range = RANGE.exec(text);
  if (range) {
    const [, prefix, fromText, secondPrefix, toText] = range;
    // "T1-T5" repeats the prefix; "1-5" and "T1-5" don't. Anything else is a name.
    if (secondPrefix === '' || tidy(secondPrefix) === tidy(prefix)) {
      const from = Number(fromText);
      const to = Number(toText);
      if (to < from) {
        return { ok: false, error: 'Start the range with the smaller number, e.g. 1–20.' };
      }
      const count = to - from + 1;
      if (count > MAX_TABLES_PER_ADD) {
        return { ok: false, error: `Add at most ${MAX_TABLES_PER_ADD} tables at a time.` };
      }
      const width = fromText.startsWith('0') ? fromText.length : 0;
      const labels = Array.from({ length: count }, (_, index) =>
        tidy(`${prefix}${String(from + index).padStart(width, '0')}`),
      );
      const tooLong = labels.find((label) => label.length > MAX_LABEL_LENGTH);
      if (tooLong) {
        return { ok: false, error: `Table names must be ${MAX_LABEL_LENGTH} characters or fewer.` };
      }
      return { ok: true, labels };
    }
  }

  if (text.length > MAX_LABEL_LENGTH) {
    return { ok: false, error: `Table names must be ${MAX_LABEL_LENGTH} characters or fewer.` };
  }
  return { ok: true, labels: [text] };
}

/** "Adds 20 tables: 1, 2, 3 … 20" style preview. */
export function describeLabels(labels: string[]): string {
  if (labels.length === 1) return `Adds table ${labels[0]}`;
  const shown =
    labels.length <= 6
      ? labels.join(', ')
      : `${labels.slice(0, 3).join(', ')} … ${labels[labels.length - 1]}`;
  return `Adds ${labels.length} tables: ${shown}`;
}
