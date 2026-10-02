import { describe, expect, it, vi } from 'vitest';

import {
  acceptableHindi,
  fillHindiNames,
  HINDI_NAMES_SYSTEM_PROMPT,
  transliterateNames,
  type HindiNameRow,
} from '@/features/menu/hindi-names';
import type { VisionProvider } from '@/lib/vision/openai-compatible';

// Automatic Hindi names (docs/DECISIONS.md HN-5 to HN-8), against a fake fetch.

const primary: VisionProvider = {
  name: 'commandcode',
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  apiKey: 'cc-key',
  model: 'google/gemini-3.8-flash',
};
const fallback: VisionProvider = {
  name: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'or-key',
  model: 'google/gemini-3.8-flash',
};

const rows: HindiNameRow[] = [
  { restaurantId: 'rest-1', kind: 'item', id: 'dish-1', name: 'Paneer Tikka' },
  { restaurantId: 'rest-1', kind: 'category', id: 'cat-1', name: 'Starters' },
];

function completion(names: Array<{ n: number; hindi: string }>) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: 'assistant', content: JSON.stringify({ names }) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 300, completion_tokens: 40 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function fakeFetch(...replies: Array<Response | ((body: Record<string, unknown>) => Response)>) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const reply = replies.shift();
    if (!reply) throw new Error('no more replies');
    return typeof reply === 'function' ? reply(body) : reply;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies };
}

describe('acceptableHindi', () => {
  it('keeps one line of Devanagari, tidied, within the limit', () => {
    expect(acceptableHindi('  पनीर   टिक्का ', 80)).toBe('पनीर टिक्का');
    expect(acceptableHindi('चिकन 65', 80)).toBe('चिकन 65');
    expect(acceptableHindi('क'.repeat(60), 60)).toBe('क'.repeat(60));
  });

  it('drops anything else', () => {
    expect(acceptableHindi('क'.repeat(61), 60)).toBeNull();
    expect(acceptableHindi('Paneer Tikka', 80)).toBeNull();
    expect(acceptableHindi('पनीर Tikka', 80)).toBeNull();
    expect(acceptableHindi('पनीर\nटिक्का', 80)).toBeNull();
    expect(acceptableHindi('   ', 80)).toBeNull();
    expect(acceptableHindi(5, 80)).toBeNull();
  });
});

describe('transliterateNames', () => {
  it('asks for the names by number, with structured output, and maps the reply back', async () => {
    const { fetchImpl, bodies } = fakeFetch(
      completion([
        { n: 0, hindi: 'पनीर टिक्का' },
        { n: 1, hindi: 'स्टार्टर्स' },
      ]),
    );
    const result = await transliterateNames(rows, [primary], fetchImpl);

    expect([...result]).toEqual([
      ['dish-1', 'पनीर टिक्का'],
      ['cat-1', 'स्टार्टर्स'],
    ]);
    const messages = bodies[0]!.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: HINDI_NAMES_SYSTEM_PROMPT });
    expect(JSON.parse(messages[1]!.content)).toEqual([
      { n: 0, name: 'Paneer Tikka' },
      { n: 1, name: 'Starters' },
    ]);
    expect(bodies[0]!.response_format).toMatchObject({ json_schema: { name: 'hindi_names' } });
  });

  it('leaves out unusable names and numbers it did not send', async () => {
    const { fetchImpl } = fakeFetch(
      completion([
        { n: 0, hindi: 'Paneer Tikka' },
        { n: 1, hindi: 'क'.repeat(61) },
        { n: 7, hindi: 'पनीर' },
      ]),
      completion([{ n: 0, hindi: 'पनीर टिक्का' }]),
    );
    // Nothing usable from the first provider, so the second is asked.
    const result = await transliterateNames(rows, [primary, fallback], fetchImpl);
    expect([...result]).toEqual([['dish-1', 'पनीर टिक्का']]);
  });

  it('moves to the next provider after an error', async () => {
    const { fetchImpl, bodies } = fakeFetch(
      new Response('busy', { status: 503 }),
      completion([{ n: 0, hindi: 'पनीर टिक्का' }]),
    );
    const result = await transliterateNames(rows.slice(0, 1), [primary, fallback], fetchImpl);
    expect(result.get('dish-1')).toBe('पनीर टिक्का');
    expect(bodies).toHaveLength(2);
  });

  it('asks again without structured output when the provider refuses it', async () => {
    const { fetchImpl, bodies } = fakeFetch(
      new Response(JSON.stringify({ error: { message: 'response_format is not supported' } }), {
        status: 400,
      }),
      completion([{ n: 0, hindi: 'पनीर टिक्का' }]),
    );
    const result = await transliterateNames(rows.slice(0, 1), [primary], fetchImpl);
    expect(result.get('dish-1')).toBe('पनीर टिक्का');
    expect(bodies[1]!.response_format).toBeUndefined();
  });

  it('sends at most 100 names a call', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      restaurantId: 'rest-1',
      kind: 'item' as const,
      id: `dish-${i}`,
      name: `Dish ${i}`,
    }));
    const answer = (body: Record<string, unknown>) => {
      const sent = JSON.parse((body.messages as Array<{ content: string }>)[1]!.content) as Array<{
        n: number;
      }>;
      return completion(sent.map(({ n }) => ({ n, hindi: `डिश ${n}` })));
    };
    const { fetchImpl, bodies } = fakeFetch(answer, answer);
    const result = await transliterateNames(many, [primary], fetchImpl);

    expect(
      bodies.map(
        (body) => JSON.parse((body.messages as Array<{ content: string }>)[1]!.content).length,
      ),
    ).toEqual([100, 50]);
    expect(result.size).toBe(150);
    expect(result.get('dish-149')).toBe('डिश 49');
  });

  it("never puts two restaurants' names in one call", async () => {
    const mixed: HindiNameRow[] = [
      { restaurantId: 'rest-1', kind: 'item', id: 'a-1', name: 'Paneer Tikka' },
      { restaurantId: 'rest-2', kind: 'item', id: 'b-1', name: 'Dal Makhani' },
      { restaurantId: 'rest-1', kind: 'category', id: 'a-2', name: 'Starters' },
    ];
    const answer = (body: Record<string, unknown>) => {
      const sent = JSON.parse((body.messages as Array<{ content: string }>)[1]!.content) as Array<{
        n: number;
      }>;
      return completion(sent.map(({ n }) => ({ n, hindi: `नाम ${n}` })));
    };
    const { fetchImpl, bodies } = fakeFetch(answer, answer);
    const result = await transliterateNames(mixed, [primary], fetchImpl);

    expect(
      bodies.map((body) =>
        (
          JSON.parse((body.messages as Array<{ content: string }>)[1]!.content) as Array<{
            name: string;
          }>
        ).map(({ name }) => name),
      ),
    ).toEqual([['Paneer Tikka', 'Starters'], ['Dal Makhani']]);
    expect(Object.fromEntries(result)).toEqual({ 'a-1': 'नाम 0', 'a-2': 'नाम 1', 'b-1': 'नाम 0' });
  });
});

describe('fillHindiNames', () => {
  it('stores the usable names for the rows that have none', async () => {
    const rpc = vi
      .fn<(fn: string, args: unknown) => Promise<{ data: unknown; error: null }>>()
      .mockImplementation(async (fn) => ({
        data:
          fn === 'menu_hindi_names_claim'
            ? rows.map(({ restaurantId, ...row }) => ({ restaurant_id: restaurantId, ...row }))
            : 1,
        error: null,
      }));
    const admin = { rpc } as unknown as Parameters<typeof fillHindiNames>[0];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(completion([{ n: 0, hindi: 'पनीर टिक्का' }]));

    await expect(fillHindiNames(admin, 'rest-1', 300, [primary])).resolves.toEqual({
      missing: 2,
      stored: 1,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, 'menu_hindi_names_claim', {
      p_restaurant_id: 'rest-1',
      p_limit: 300,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'menu_set_hindi_names', {
      p_names: [{ kind: 'item', id: 'dish-1', name: 'Paneer Tikka', name_hi: 'पनीर टिक्का' }],
    });
    fetchSpy.mockRestore();
  });

  it('does nothing without a provider', async () => {
    const rpc = vi.fn();
    const admin = { rpc } as unknown as Parameters<typeof fillHindiNames>[0];
    await expect(fillHindiNames(admin, null, 500, [])).resolves.toEqual({ missing: 0, stored: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });
});
