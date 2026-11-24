import { beforeEach, describe, expect, it, vi } from 'vitest';

import { finishReading } from '@/features/menu-import/actions';
import type { PageExtraction } from '@/features/menu-import/draft';
import { READER_UNAVAILABLE, UNREADABLE_PAGE } from '@/features/menu-import/extract';

// Putting the pages read into one draft, or failing the import when no page gave a dish, and
// refusing while a page is still held (docs/DECISIONS.md P7-15, VPS-5).

const IMPORT_ID = '123e4567-e89b-42d3-a456-426614174000';

const READER_DOWN = 'The menu reader is not answering right now. Try again in a few minutes.';
const NO_DISHES_FOUND =
  'No dishes could be read from these photos. Take a sharper photo, straight on and in good light, of one page at a time.';
const STILL_READING =
  'A page is still being read, or its reading was cut off. Try again in a minute or two.';

const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  // The import as the caller reads it.
  row: null as { status: string; pages: unknown[] } | null,
}));
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ requireUser: async () => ({}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: db.row, error: null }) }) }),
    }),
    rpc: db.rpc,
  }),
}));

const dalTadka: PageExtraction = {
  categories: [
    {
      name: 'Mains',
      items: [
        {
          name: 'Dal Tadka',
          description: null,
          food_type: 'veg',
          price: 180,
          variants: [],
          confidence: 'high',
          notes: null,
        },
      ],
    },
  ],
  page_notes: null,
};

const read = (index: number) => ({ index, status: 'done', error: null, result: dalTadka });
/** A page the reader never answered for, even on its second try. */
const unavailable = (index: number) => ({ index, status: 'failed', error: READER_UNAVAILABLE });

beforeEach(() => {
  db.row = { status: 'processing', pages: [] };
  db.rpc.mockResolvedValue({ data: null, error: null });
});

describe('finishReading', () => {
  it('fails a one-page import with the reader’s message when the reader never answered', async () => {
    db.row = { status: 'processing', pages: [unavailable(1)] };

    await expect(finishReading(IMPORT_ID)).resolves.toMatchObject({
      ok: true,
      data: { status: 'failed' },
    });

    expect(db.rpc).toHaveBeenCalledWith('menu_import_set_draft', {
      p_import_id: IMPORT_ID,
      p_status: 'failed',
      p_error: READER_DOWN,
    });
  });

  it('does the same when the reader never answered for any page of a longer import', async () => {
    db.row = { status: 'processing', pages: [unavailable(1), unavailable(2), unavailable(3)] };

    await expect(finishReading(IMPORT_ID)).resolves.toMatchObject({
      ok: true,
      data: { status: 'failed' },
    });

    expect(db.rpc).toHaveBeenCalledWith('menu_import_set_draft', {
      p_import_id: IMPORT_ID,
      p_status: 'failed',
      p_error: READER_DOWN,
    });
  });

  it('opens the review with the pages that were read when the reader failed on only some', async () => {
    db.row = { status: 'processing', pages: [read(1), unavailable(2)] };

    await expect(finishReading(IMPORT_ID)).resolves.toMatchObject({
      ok: true,
      data: { status: 'review' },
    });

    expect(db.rpc).toHaveBeenCalledWith('menu_import_set_draft', {
      p_import_id: IMPORT_ID,
      p_status: 'review',
      p_draft: expect.objectContaining({
        version: 1,
        categories: [
          expect.objectContaining({
            name: 'Mains',
            items: [expect.objectContaining({ name: 'Dal Tadka', page: 1 })],
          }),
        ],
      }),
    });
  });

  it('blames the photos, not the reader, when a page failed for another reason', async () => {
    db.row = {
      status: 'processing',
      pages: [unavailable(1), { index: 2, status: 'failed', error: UNREADABLE_PAGE }],
    };

    await expect(finishReading(IMPORT_ID)).resolves.toMatchObject({
      ok: true,
      data: { status: 'failed' },
    });

    expect(db.rpc).toHaveBeenCalledWith('menu_import_set_draft', {
      p_import_id: IMPORT_ID,
      p_status: 'failed',
      p_error: NO_DISHES_FOUND,
    });
  });

  it.each(['pending', 'reading'])(
    'asks to try again in a minute or two while a page is %s',
    async (status) => {
      // A claim held by another tab, or left by a read a deploy cut off, lapses after 3 minutes.
      db.row = { status: 'processing', pages: [read(1), { index: 2, status }] };

      await expect(finishReading(IMPORT_ID)).resolves.toMatchObject({
        ok: false,
        error: STILL_READING,
      });

      expect(db.rpc).not.toHaveBeenCalled();
    },
  );
});
