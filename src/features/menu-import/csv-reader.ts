import { normalizeCategoryName } from '@/features/menu/default-categories';
import { parsePriceInput } from '@/features/menu/schemas';

import {
  emptyDraft,
  MAX_IMPORT_ITEMS,
  MAX_VARIANTS,
  normalizeItemName,
  tidyText,
  type Draft,
  type DraftCategory,
  type DraftItem,
  type ImportFoodType,
} from './draft';

/**
 * Menu CSV → draft (spec §13.4, docs/DECISIONS.md P7-16). Columns, any order,
 * case-insensitive: category, name, description, food_type, price,
 * variant_name, variant_price. Rows in a row with the same category and name
 * are one dish; a variant_name makes the row an option of it.
 */

export const MAX_CSV_BYTES = 1024 * 1024;
export const CSV_COLUMNS = [
  'category',
  'name',
  'description',
  'food_type',
  'price',
  'variant_name',
  'variant_price',
] as const;
type Column = (typeof CSV_COLUMNS)[number];

const MAX_ERRORS = 20;

/** RFC 4180 records: quoted fields, "" escapes, commas and line breaks inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < text.length) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += char;
      }
      i += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      if (char === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      field += char;
    }
    i += 1;
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

export type CsvError = { row: number | null; message: string };
export type CsvResult =
  | { ok: true; draft: Draft; dishes: number }
  | { ok: false; errors: CsvError[]; moreErrors: number };

const FOOD_TYPE_WORDS: Record<string, ImportFoodType> = {
  veg: 'veg',
  vegetarian: 'veg',
  non_veg: 'non_veg',
  'non-veg': 'non_veg',
  'non veg': 'non_veg',
  nonveg: 'non_veg',
  egg: 'egg',
  eggetarian: 'egg',
};

function headerKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export function csvToDraft(text: string): CsvResult {
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES) {
    return fail([
      { row: null, message: 'The file is larger than 1 MB. Split it into smaller files.' },
    ]);
  }

  // Row numbers are the ones a spreadsheet shows, so blank lines still count.
  const records = parseCsv(text)
    .map((cells, index) => ({ cells, row: index + 1 }))
    .filter((record) => record.cells.some((cell) => cell.trim() !== ''));
  if (records.length === 0) return fail([{ row: null, message: 'The file is empty.' }]);

  // Header row.
  const header = records[0]!.cells.map(headerKey);
  const columns = new Map<Column, number>();
  for (const column of CSV_COLUMNS) {
    const index = header.indexOf(column);
    if (index >= 0) columns.set(column, index);
  }
  const missing = (['category', 'name'] as const).filter((column) => !columns.has(column));
  if (!columns.has('price') && !columns.has('variant_price')) missing.push('price' as never);
  if (missing.length > 0) {
    return fail([
      {
        row: 1,
        message: `The first row must name the columns. Missing: ${missing.join(', ')}.`,
      },
    ]);
  }

  const cell = (record: string[], column: Column): string => {
    const index = columns.get(column);
    return index === undefined ? '' : tidyText(record[index]);
  };

  const errors: CsvError[] = [];
  const draft = emptyDraft();
  const byName = new Map<string, DraftCategory>();
  let dishes = 0;
  let previous: { category: string; name: string; item: DraftItem; row: number } | null = null;

  records.slice(1).forEach(({ cells: record, row }) => {
    const rowErrors: string[] = [];

    const categoryName = cell(record, 'category');
    const name = cell(record, 'name');
    const description = cell(record, 'description');
    const foodWord = cell(record, 'food_type').toLowerCase();
    const priceText = cell(record, 'price');
    const variantName = cell(record, 'variant_name');
    const variantPriceText = cell(record, 'variant_price');

    if (!categoryName) rowErrors.push('the category is missing');
    else if (categoryName.length > 60) rowErrors.push('the category is longer than 60 characters');
    if (!name) rowErrors.push('the dish name is missing');
    else if (name.length > 80) rowErrors.push('the dish name is longer than 80 characters');
    if (description.length > 300) rowErrors.push('the description is longer than 300 characters');
    if (variantName.length > 40) rowErrors.push('the variant name is longer than 40 characters');

    let foodType: ImportFoodType = 'unknown';
    if (foodWord) {
      const known = FOOD_TYPE_WORDS[foodWord];
      if (known) foodType = known;
      else rowErrors.push(`food_type "${foodWord}" should be veg, non_veg or egg`);
    }

    const readPrice = (text: string, label: string): number | null => {
      if (!text) return null;
      const paise = parsePriceInput(text);
      if (paise === null) rowErrors.push(`${label} "${text}" is not a price in rupees`);
      return paise;
    };
    const price = readPrice(priceText, 'price');
    const variantPrice = readPrice(variantPriceText, 'variant_price');

    const sameDish =
      previous !== null &&
      normalizeCategoryName(previous.category) === normalizeCategoryName(categoryName) &&
      normalizeItemName(previous.name) === normalizeItemName(name);

    if (variantName) {
      if (variantPrice === null && price === null && !rowErrors.some((e) => e.includes('price'))) {
        rowErrors.push('the variant has no price');
      }
      if (sameDish && previous!.item.variants.length === 0) {
        rowErrors.push(
          `the dish on row ${previous!.row} has no variant_name; give every row of a dish with options one`,
        );
      }
    } else if (sameDish) {
      rowErrors.push(
        `it repeats the dish on row ${previous!.row}; add a variant_name to list its options`,
      );
    } else if (price === null && !rowErrors.some((e) => e.includes('price'))) {
      rowErrors.push('the price is missing');
    }

    if (rowErrors.length > 0) {
      errors.push({ row, message: `Row ${row}: ${rowErrors.join('; ')}.` });
      return;
    }

    // An option of the dish on the previous row.
    if (variantName && sameDish && previous!.item.variants.length > 0) {
      if (previous!.item.variants.length >= MAX_VARIANTS) {
        errors.push({
          row,
          message: `Row ${row}: a dish can have at most ${MAX_VARIANTS} options.`,
        });
        return;
      }
      previous!.item.variants.push({ name: variantName, price_paise: variantPrice ?? price });
      return;
    }

    let category = byName.get(normalizeCategoryName(categoryName));
    if (!category) {
      category = {
        key: `c${byName.size + 1}`,
        name: categoryName,
        skip: false,
        show_hidden: false,
        items: [],
      };
      byName.set(normalizeCategoryName(categoryName), category);
      draft.categories.push(category);
    }

    const item: DraftItem = {
      key: `r${row}`,
      page: null,
      name,
      description: description || null,
      food_type: foodType,
      price_paise: variantName ? null : price,
      variants: variantName ? [{ name: variantName, price_paise: variantPrice ?? price }] : [],
      confidence: 'high',
      notes: null,
      reviewed: false,
      action: 'import',
      existing_item_id: null,
    };
    category.items.push(item);
    dishes += 1;
    previous = { category: categoryName, name, item, row };
  });

  if (dishes > MAX_IMPORT_ITEMS) {
    errors.unshift({
      row: null,
      message: `The file has ${dishes} dishes; an import takes at most ${MAX_IMPORT_ITEMS}. Split it into smaller files.`,
    });
  }
  if (errors.length > 0) return fail(errors);
  if (dishes === 0) return fail([{ row: null, message: 'The file has no dishes.' }]);
  return { ok: true, draft, dishes };
}

function fail(errors: CsvError[]): CsvResult {
  return {
    ok: false,
    errors: errors.slice(0, MAX_ERRORS),
    moreErrors: Math.max(0, errors.length - MAX_ERRORS),
  };
}
