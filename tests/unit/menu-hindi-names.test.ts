import { getEventListeners } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acceptableHindi,
  fillHindiNames,
  fillWaitingHindiNames,
  HINDI_NAMES_SYSTEM_PROMPT,
  queueHindiNames,
  transliterateNames,
  type HindiNameRow,
} from '@/features/menu/hindi-names';
import type { JobRun } from '@/lib/jobs';
import type { VisionProvider } from '@/lib/vision/openai-compatible';

// Automatic Hindi names (docs/DECISIONS.md HN-5 to HN-8, VPS-27), against a fake fetch and a fake
// Supabase client: the names are leased, written and settled batch by batch.

const next = vi.hoisted(() => ({ tasks: [] as (() => Promise<unknown>)[] }));
vi.mock('next/server', () => ({
  after: (task: () => Promise<unknown>) => next.tasks.push(task),
}));
const config = vi.hoisted(() => ({ providers: [] as unknown[] }));
vi.mock('@/features/menu-import/providers', () => ({
  menuImportProviders: () => config.providers,
}));
const db = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.admin }));

beforeEach(() => {
  next.tasks.length = 0;
  config.providers = [];
});

afterEach(() => {
  vi.useRealTimers();
});

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

/** A fetch that never answers, until its call is aborted: then it rejects, as fetch does. */
function hangingFetch() {
  const hang = vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason));
      }),
  );
  return { fetchImpl: hang as unknown as typeof fetch, hang };
}

/** A run that goes on until the test stops it, as the server stopping does. */
function stoppableRun() {
  const server = new AbortController();
  const run: JobRun = { signal: server.signal, stopping: () => server.signal.aborted };
  return { run, stop: (reason?: unknown) => server.abort(reason) };
}

type Leased = { restaurant_id: string; kind: string; id: string; name: string };

const leasedRow = ({ restaurantId, ...row }: HindiNameRow): Leased => ({
  restaurant_id: restaurantId,
  ...row,
});

/** One dish of rest-1 to be written. */
const dish = (id: string): Leased =>
  leasedRow({ restaurantId: 'rest-1', kind: 'item', id, name: `Dish ${id}` });

type Reply = { data: unknown; error: { message: string } | null };

/**
 * A Supabase client whose lease hands out these batches in turn, then nothing (or asks a function
 * for as many names as were asked for), and whose settle counts the names it was given. `answer`
 * can answer a call itself.
 */
function fakeAdmin(
  batches: Leased[][] | ((limit: number) => Leased[]),
  answer: (fn: string, args: Record<string, unknown>) => Reply | undefined = () => undefined,
) {
  const queue = typeof batches === 'function' ? [] : [...batches];
  const lease = typeof batches === 'function' ? batches : () => queue.shift() ?? [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>): Promise<Reply> => {
    const own = answer(fn, args);
    if (own) return own;
    if (fn === 'menu_hindi_names_lease') {
      return { data: lease(Number(args.p_limit)), error: null };
    }
    const names = args.p_names as Array<{ name_hi?: string }>;
    return { data: names.filter((entry) => entry.name_hi).length, error: null };
  });
  const admin = { rpc } as unknown as Parameters<typeof fillHindiNames>[0];
  const calls = (fn: string) =>
    rpc.mock.calls.filter(([name]) => name === fn).map(([, args]) => args);
  return { admin, rpc, calls, order: () => rpc.mock.calls.map(([fn]) => fn) };
}

/**
 * OpenRouter's 403s as its docs show them (https://openrouter.ai/docs/api-reference/errors and
 * https://openrouter.ai/docs/guides/features/guardrails, read 2026-11-11). The docs give the fields
 * of a moderation flag and of a typed refusal but no message, so the messages here name none of the
 * words a 403 was once read for: the fields alone decide.
 */
const openRouter403 = {
  /** A guardrail's content check: refused for what the names say. */
  injection: {
    error: {
      code: 403,
      message: 'Request blocked: prompt injection patterns detected',
      metadata: { patterns: ['ignore all previous instructions'] },
    },
  },
  /** A moderation flag (ModerationErrorMetadata). */
  moderation: {
    error: {
      code: 403,
      message: 'Your input was rejected',
      metadata: {
        reasons: ['violence'],
        flagged_input: 'Death by Chocolate',
        provider_name: 'Google',
        model_slug: 'google/gemini-3.8-flash',
      },
    },
  },
  /** The workspace takes requests only through the EU hostname: no names can cause it. */
  dataRegion: {
    error: {
      code: 403,
      message:
        "This request arrived on the global data region, but the key's workspace permits requests only on these OpenRouter hostnames: eu.openrouter.ai. Use one of the permitted hostnames or update the workspace guardrail allowed data regions.",
    },
  },
  /** A guardrail's budget is spent. */
  budget: {
    error: {
      code: 403,
      message:
        'Budget limit exceeded (weekly limit). Contact your org admin. $52.00 of $50.00 used; resets 2026-10-12T00:00:00.000Z.',
      metadata: {
        limit_source: 'openrouter_guardrail_budget',
        remedy_hint:
          'Wait for the budget window to reset (see metadata.resets_at), or ask your org admin to raise the guardrail budget.',
        scope: 'workspace_default_member',
        limit_usd: 50,
        spend_usd: 52,
        resets_at: '2026-10-12T00:00:00.000Z',
      },
    },
  },
};

/** A provider's refusal as OpenRouter types it, in error.metadata.error_type. */
const typedRefusal = (errorType: 'content_policy_violation' | 'refusal') => ({
  error: {
    code: 403,
    message: 'Provider returned error',
    metadata: { error_type: errorType, provider_name: 'Google' },
  },
});

const forbidden = (body: unknown) => new Response(JSON.stringify(body), { status: 403 });

/** A provider's trouble that no batch of names can cause, as far as its answer shows: an outage. */
const outages: [string, () => Response][] = [
  [
    'cannot be reached',
    () => {
      throw new TypeError('fetch failed');
    },
  ],
  ['answers 401', () => new Response('{"error":{"message":"invalid key"}}', { status: 401 })],
  [
    'answers 402',
    () => new Response('{"error":{"message":"insufficient credits"}}', { status: 402 }),
  ],
  ['answers 403', () => new Response('forbidden', { status: 403 })],
  ["answers OpenRouter's 403 for its data region", () => forbidden(openRouter403.dataRegion)],
  ["answers OpenRouter's 403 for a spent budget", () => forbidden(openRouter403.budget)],
  [
    "answers OpenRouter's typed 403 for a permission",
    () =>
      forbidden({
        error: {
          code: 403,
          message: 'Provider returned error',
          metadata: { error_type: 'permission_denied', provider_name: 'Google' },
        },
      }),
  ],
  [
    'answers a 403 whose content fields are not of their documented types',
    () =>
      forbidden({
        error: {
          code: 403,
          message: 'Request blocked',
          metadata: { reasons: 'violence', flagged_input: ['Death by Chocolate'], patterns: 'x' },
        },
      }),
  ],
  [
    'answers a 403 that says moderation, without its fields',
    () =>
      forbidden({
        error: { code: 403, message: 'google/gemini-3.8-flash requires moderation on OpenRouter' },
      }),
  ],
  [
    'answers a 403 that says guardrail, without its fields',
    () => forbidden({ error: { code: 403, message: 'Blocked by guardrail' } }),
  ],
  ['answers 404', () => new Response('{"error":{"message":"no such model"}}', { status: 404 })],
  ['answers 408', () => new Response('request timeout', { status: 408 })],
  ['answers 429', () => new Response('rate limited', { status: 429 })],
  ['answers 500', () => new Response('error', { status: 500 })],
  ['answers 503', () => new Response('busy', { status: 503 })],
];

/** Writes every name it is sent, as नाम and its number. */
const writeAll = (body: Record<string, unknown>) => {
  const sent = JSON.parse((body.messages as Array<{ content: string }>)[1]!.content) as Array<{
    n: number;
  }>;
  return completion(sent.map(({ n }) => ({ n, hindi: `नाम ${n}` })));
};

describe('acceptableHindi', () => {
  it('keeps one line of Devanagari, tidied, within the limit', () => {
    expect(acceptableHindi('  पनीर   टिक्का ', 80)).toBe('पनीर टिक्का');
    expect(acceptableHindi('चिकन 65', 80)).toBe('चिकन 65');
    expect(acceptableHindi('क'.repeat(60), 60)).toBe('क'.repeat(60));
    // A tab is space, tidied before the control characters are looked for; a joiner is no control.
    expect(acceptableHindi('पनीर\tटिक्का', 80)).toBe('पनीर टिक्का');
    expect(acceptableHindi('क्‍ष', 80)).toBe('क्‍ष');
  });

  it('drops anything else', () => {
    expect(acceptableHindi('क'.repeat(61), 60)).toBeNull();
    expect(acceptableHindi('Paneer Tikka', 80)).toBeNull();
    expect(acceptableHindi('पनीर Tikka', 80)).toBeNull();
    expect(acceptableHindi('पनीर\nटिक्का', 80)).toBeNull();
    expect(acceptableHindi('   ', 80)).toBeNull();
    expect(acceptableHindi(5, 80)).toBeNull();
    // Postgres holds neither \u0000 nor half a surrogate pair, so the settle would fail each time.
    expect(acceptableHindi('मसाला\u0000 चाय', 80)).toBeNull();
    expect(acceptableHindi('म\ud800', 80)).toBeNull();
    expect(acceptableHindi('\udc00मसाला', 80)).toBeNull();
    expect(acceptableHindi('मसाला\u0085चाय', 80)).toBeNull();
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

    expect([...result!]).toEqual([
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
    expect([...result!]).toEqual([['dish-1', 'पनीर टिक्का']]);
  });

  it('moves to the next provider after an error', async () => {
    const { fetchImpl, bodies } = fakeFetch(
      new Response('busy', { status: 503 }),
      completion([{ n: 0, hindi: 'पनीर टिक्का' }]),
    );
    const result = await transliterateNames(rows.slice(0, 1), [primary, fallback], fetchImpl);
    expect(result!.get('dish-1')).toBe('पनीर टिक्का');
    expect(bodies).toHaveLength(2);
  });

  it.each(outages)('answers null when every provider %s: no name is to blame', async (_, reply) => {
    const { fetchImpl, bodies } = fakeFetch(reply, reply);
    await expect(transliterateNames(rows, [primary, fallback], fetchImpl)).resolves.toBeNull();
    expect(bodies).toHaveLength(2);
  });

  it.each<[string, Response]>([
    ['sends no usable names', completion([{ n: 0, hindi: 'Paneer Tikka' }])],
    ['sends a reply that is not JSON', new Response('<html></html>', { status: 200 })],
    ['answers 422', new Response('too many names', { status: 422 })],
  ])('still answers, with nothing, when a provider %s after another was down', async (_, reply) => {
    // It may be the names' doing, so they count as tried, and a batch that always fails can't loop.
    const { fetchImpl } = fakeFetch(new Response('busy', { status: 503 }), reply);
    await expect(transliterateNames(rows, [primary, fallback], fetchImpl)).resolves.toEqual(
      new Map(),
    );
  });

  it('still answers, with nothing, when a provider runs out of time after another was down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let asked = 0;
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      ++asked === 1
        ? Promise.resolve(new Response('busy', { status: 503 }))
        : new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
          }),
    ) as unknown as typeof fetch;

    const writing = transliterateNames(rows, [primary, fallback], fetchImpl);
    await vi.waitFor(() => expect(asked).toBe(2));
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(writing).resolves.toEqual(new Map());
  });

  it('asks again without structured output when the provider refuses it', async () => {
    const { fetchImpl, bodies } = fakeFetch(
      new Response(JSON.stringify({ error: { message: 'response_format is not supported' } }), {
        status: 400,
      }),
      completion([{ n: 0, hindi: 'पनीर टिक्का' }]),
    );
    const result = await transliterateNames(rows.slice(0, 1), [primary], fetchImpl);
    expect(result!.get('dish-1')).toBe('पनीर टिक्का');
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
    expect(result!.size).toBe(150);
    expect(result!.get('dish-149')).toBe('डिश 49');
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
    expect(Object.fromEntries(result!)).toEqual({ 'a-1': 'नाम 0', 'a-2': 'नाम 1', 'b-1': 'नाम 0' });
  });

  it("rejects with the signal's reason, not a provider error, when it aborts a call", async () => {
    const reason = new DOMException('The server is stopping', 'AbortError');
    const server = new AbortController();
    const { fetchImpl, hang } = hangingFetch();

    // Not an unanswered call: with only this provider, that would end as names it could not write.
    const writing = transliterateNames(rows, [primary], fetchImpl, server.signal);
    await vi.waitFor(() => expect(hang).toHaveBeenCalledTimes(1));
    server.abort(reason);

    await expect(writing).rejects.toBe(reason);
    expect(getEventListeners(server.signal, 'abort')).toHaveLength(0);
  });

  it('sends nothing once the signal has aborted', async () => {
    const reason = new DOMException('The server is stopping', 'AbortError');
    const server = new AbortController();
    server.abort(reason);
    const { fetchImpl, hang } = hangingFetch();

    await expect(
      transliterateNames(rows, [primary, fallback], fetchImpl, server.signal),
    ).rejects.toBe(reason);
    expect(hang).not.toHaveBeenCalled();
  });

  it('leaves no listener on a signal that never aborts', async () => {
    const server = new AbortController();
    const { fetchImpl } = fakeFetch(completion([{ n: 0, hindi: 'पनीर टिक्का' }]));

    await transliterateNames(rows.slice(0, 1), [primary], fetchImpl, server.signal);
    expect(getEventListeners(server.signal, 'abort')).toHaveLength(0);
  });
});

describe('fillHindiNames', () => {
  it('leases the names, has the usable ones written and settles the batch', async () => {
    const { admin, rpc } = fakeAdmin([rows.map(leasedRow)]);
    const { fetchImpl } = fakeFetch(completion([{ n: 0, hindi: 'पनीर टिक्का' }]));
    const { run } = stoppableRun();

    await expect(
      fillHindiNames(admin, {
        restaurantId: 'rest-1',
        maxNames: 300,
        lanes: 1,
        run,
        providers: [primary],
        fetchImpl,
      }),
    ).resolves.toEqual({ leased: 2, stored: 1 });
    expect(rpc).toHaveBeenNthCalledWith(1, 'menu_hindi_names_lease', {
      p_restaurant_id: 'rest-1',
      p_limit: 100,
      p_lease_seconds: 300,
    });
    // Every leased name is settled: the one the model wrote with it, the other as tried.
    const settled = rpc.mock.calls[1]!;
    expect(settled[0]).toBe('menu_hindi_names_settle');
    expect(settled[1]).toEqual({
      p_names: [
        { kind: 'item', id: 'dish-1', name: 'Paneer Tikka', name_hi: 'पनीर टिक्का' },
        { kind: 'category', id: 'cat-1', name: 'Starters' },
      ],
    });
    expect((settled[1].p_names as object[])[1]).not.toHaveProperty('name_hi');
    // Then it asks for more, and there is none.
    expect(rpc).toHaveBeenNthCalledWith(3, 'menu_hindi_names_lease', expect.anything());
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("asks for every restaurant's names, five lanes at a time, up to maxNames", async () => {
    const { admin, calls } = fakeAdmin([]);
    const { run } = stoppableRun();

    await expect(
      fillHindiNames(admin, { run, maxNames: 500, providers: [primary] }),
    ).resolves.toEqual({ leased: 0, stored: 0 });
    const leases = calls('menu_hindi_names_lease');
    expect(leases).toHaveLength(5);
    for (const lease of leases) {
      expect(lease).toEqual({ p_limit: 100, p_lease_seconds: 300 });
      expect(lease.p_restaurant_id).toBeUndefined();
    }
  });

  it('does nothing without a provider', async () => {
    const { admin, rpc } = fakeAdmin([]);
    const { run } = stoppableRun();
    await expect(fillHindiNames(admin, { run, providers: [] })).resolves.toEqual({
      leased: 0,
      stored: 0,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('settles each batch before it leases the next', async () => {
    const { admin, order } = fakeAdmin([[dish('a')], [dish('b')]]);
    const { fetchImpl } = fakeFetch(
      completion([{ n: 0, hindi: 'डिश ए' }]),
      completion([{ n: 0, hindi: 'डिश बी' }]),
    );
    const { run } = stoppableRun();

    await expect(
      fillHindiNames(admin, { lanes: 1, run, providers: [primary], fetchImpl }),
    ).resolves.toEqual({ leased: 2, stored: 2 });
    expect(order()).toEqual([
      'menu_hindi_names_lease',
      'menu_hindi_names_settle',
      'menu_hindi_names_lease',
      'menu_hindi_names_settle',
      'menu_hindi_names_lease',
    ]);
  });

  it('stores a batch that has answered while another is still being written', async () => {
    const { admin, calls } = fakeAdmin([[dish('a')], [dish('b')]]);
    let asked = 0;
    // The first batch is answered; the second never is.
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      asked += 1;
      if (asked === 1) return completion([{ n: 0, hindi: 'डिश ए' }]);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason));
      });
    }) as unknown as typeof fetch;
    const { run, stop } = stoppableRun();

    const filling = fillHindiNames(admin, { lanes: 2, run, providers: [primary], fetchImpl });
    await vi.waitFor(() => expect(calls('menu_hindi_names_settle')).toHaveLength(1));
    expect(calls('menu_hindi_names_settle')[0]).toEqual({
      p_names: [{ kind: 'item', id: 'a', name: 'Dish a', name_hi: 'डिश ए' }],
    });

    // The server stops with the second still out: it settles nothing.
    stop();
    await expect(filling).resolves.toEqual({ leased: 2, stored: 1, stopped: true });
    expect(calls('menu_hindi_names_settle')).toHaveLength(1);
  });

  it('settles nothing for a call that the server stopping aborts', async () => {
    const { admin, order } = fakeAdmin([rows.map(leasedRow)]);
    const { fetchImpl, hang } = hangingFetch();
    const { run, stop } = stoppableRun();

    const filling = fillHindiNames(admin, {
      lanes: 1,
      run,
      providers: [primary, fallback],
      fetchImpl,
    });
    await vi.waitFor(() => expect(hang).toHaveBeenCalledTimes(1));
    stop(new DOMException('The server is stopping', 'AbortError'));

    await expect(filling).resolves.toEqual({ leased: 2, stored: 0, stopped: true });
    // Leased and left: the lease runs out, and the names are leased again.
    expect(order()).toEqual(['menu_hindi_names_lease']);
    expect(hang).toHaveBeenCalledTimes(1);
  });

  it('settles nothing and ends the run when every provider is down', async () => {
    const { admin, calls } = fakeAdmin(Array.from({ length: 8 }, (_, n) => [dish(`d${n}`)]));
    const fetchImpl = vi.fn(
      async () => new Response('busy', { status: 503 }),
    ) as unknown as typeof fetch;
    const { run } = stoppableRun();

    // Every lane, and no cap, so that only the outage ends the run.
    await expect(
      fillHindiNames(admin, { run, providers: [primary, fallback], fetchImpl }),
    ).resolves.toEqual({ leased: 5, stored: 0, stopped: 'unavailable' });
    // Not counted as tried: the leases run out, and the names are leased again.
    expect(calls('menu_hindi_names_settle')).toEqual([]);
    // One batch a lane, each asked of both providers, and no lane leased again.
    expect(calls('menu_hindi_names_lease')).toHaveLength(5);
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it.each([
    ['has no credit', 402, 'Your account or API key has insufficient credits'],
    ['does not have the model', 404, 'No endpoints found for google/gemini-3.8-flash'],
  ])('settles nothing when one provider is down and the other %s', async (_, status, message) => {
    const { admin, calls } = fakeAdmin(Array.from({ length: 8 }, (_, n) => [dish(`d${n}`)]));
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith(fallback.baseUrl)
        ? new Response(JSON.stringify({ error: { message, code: status } }), { status })
        : new Response('busy', { status: 503 }),
    ) as unknown as typeof fetch;
    const { run } = stoppableRun();

    await expect(
      fillHindiNames(admin, { run, providers: [primary, fallback], fetchImpl }),
    ).resolves.toEqual({ leased: 5, stored: 0, stopped: 'unavailable' });
    expect(calls('menu_hindi_names_settle')).toEqual([]);
  });

  it('still counts a batch as tried when no provider could write it', async () => {
    const { admin, calls } = fakeAdmin([[dish('a')]]);
    const { fetchImpl } = fakeFetch(
      new Response('busy', { status: 503 }),
      completion([{ n: 0, hindi: 'Dish a' }]),
    );
    const { run } = stoppableRun();

    await expect(
      fillHindiNames(admin, { lanes: 1, run, providers: [primary, fallback], fetchImpl }),
    ).resolves.toEqual({ leased: 1, stored: 0 });
    expect(calls('menu_hindi_names_settle')).toEqual([
      { p_names: [{ kind: 'item', id: 'a', name: 'Dish a' }] },
    ]);
  });

  it.each([
    ['a prompt injection', openRouter403.injection],
    ['a moderation flag', openRouter403.moderation],
    ['a content filter (content_policy_violation)', typedRefusal('content_policy_violation')],
    ["the model's refusal (refusal)", typedRefusal('refusal')],
  ])(
    'counts a batch as tried when OpenRouter refuses it for what it says (403: %s)',
    async (_, body) => {
      // It may be the names' doing, as any 4xx: settled, so that it cannot loop.
      const { admin, calls } = fakeAdmin([[dish('a')]]);
      const { fetchImpl } = fakeFetch(new Response('busy', { status: 503 }), forbidden(body));
      const { run } = stoppableRun();

      await expect(
        fillHindiNames(admin, { lanes: 1, run, providers: [primary, fallback], fetchImpl }),
      ).resolves.toEqual({ leased: 1, stored: 0 });
      expect(calls('menu_hindi_names_settle')).toEqual([
        { p_names: [{ kind: 'item', id: 'a', name: 'Dish a' }] },
      ]);
    },
  );

  it('never sends the settle a name Postgres cannot hold', async () => {
    const { admin, calls } = fakeAdmin([[dish('a'), dish('b')]]);
    const { fetchImpl } = fakeFetch(
      completion([
        { n: 0, hindi: 'मसाला\u0000 चाय' },
        { n: 1, hindi: 'म\ud800' },
      ]),
    );
    const { run } = stoppableRun();

    await expect(
      fillHindiNames(admin, { lanes: 1, run, providers: [primary], fetchImpl }),
    ).resolves.toEqual({ leased: 2, stored: 0 });
    // Counted as tried, so the batch is not leased and sent to the model again every 5 minutes.
    expect(calls('menu_hindi_names_settle')).toEqual([
      {
        p_names: [
          { kind: 'item', id: 'a', name: 'Dish a' },
          { kind: 'item', id: 'b', name: 'Dish b' },
        ],
      },
    ]);
  });

  it('leases no more than maxNames', async () => {
    let made = 0;
    const { admin, calls } = fakeAdmin((limit) =>
      Array.from({ length: limit }, () => dish(`d${made++}`)),
    );
    const { fetchImpl } = fakeFetch(writeAll, writeAll);
    const { run } = stoppableRun();

    await expect(
      fillHindiNames(admin, { maxNames: 150, lanes: 2, run, providers: [primary], fetchImpl }),
    ).resolves.toEqual({ leased: 150, stored: 150 });
    // The lanes asked together, and the second was given what was left.
    expect(calls('menu_hindi_names_lease').map((args) => args.p_limit)).toEqual([100, 50]);
  });

  it('asks again for what a short lease left of the allowance', async () => {
    const { admin, calls } = fakeAdmin([[dish('a')], [dish('b')], [dish('c')]]);
    const { fetchImpl } = fakeFetch(writeAll, writeAll, writeAll);
    const { run } = stoppableRun();

    await expect(
      fillHindiNames(admin, { maxNames: 3, lanes: 1, run, providers: [primary], fetchImpl }),
    ).resolves.toEqual({ leased: 3, stored: 3 });
    expect(calls('menu_hindi_names_lease').map((args) => args.p_limit)).toEqual([3, 2, 1]);
  });

  it('starts no batch once the run is over', async () => {
    const { admin, rpc } = fakeAdmin([[dish('a')]]);
    const over: JobRun = { signal: new AbortController().signal, stopping: () => true };
    await expect(fillHindiNames(admin, { run: over, providers: [primary] })).resolves.toEqual({
      leased: 0,
      stored: 0,
    });
    expect(rpc).not.toHaveBeenCalled();

    // Out of time after a batch: the one going on finishes, and no other starts.
    const { admin: second, order } = fakeAdmin([[dish('a')], [dish('b')]]);
    const { fetchImpl } = fakeFetch(writeAll, writeAll);
    const budgetSpent: JobRun = {
      signal: new AbortController().signal,
      stopping: () => order().includes('menu_hindi_names_settle'),
    };
    await expect(
      fillHindiNames(second, { lanes: 1, run: budgetSpent, providers: [primary], fetchImpl }),
    ).resolves.toEqual({ leased: 1, stored: 1 });
    expect(order()).toEqual(['menu_hindi_names_lease', 'menu_hindi_names_settle']);
  });

  it('throws a database error once every lane has ended', async () => {
    let leases = 0;
    const { admin, calls } = fakeAdmin([[dish('a')]], (fn) =>
      fn === 'menu_hindi_names_lease' && ++leases === 1
        ? { data: null, error: { message: 'connection lost' } }
        : undefined,
    );
    const { fetchImpl } = fakeFetch(writeAll);
    const { run } = stoppableRun();

    await expect(
      fillHindiNames(admin, { lanes: 2, run, providers: [primary], fetchImpl }),
    ).rejects.toThrow('Could not lease missing Hindi names: connection lost');
    // The other lane was left to finish its batch.
    expect(calls('menu_hindi_names_settle')).toHaveLength(1);
  });

  it('throws when a batch cannot be stored', async () => {
    const { admin } = fakeAdmin([[dish('a')]], (fn) =>
      fn === 'menu_hindi_names_settle' ? { data: null, error: { message: 'too slow' } } : undefined,
    );
    const { fetchImpl } = fakeFetch(writeAll);
    const { run } = stoppableRun();

    await expect(
      fillHindiNames(admin, { lanes: 1, run, providers: [primary], fetchImpl }),
    ).rejects.toThrow('Could not store Hindi names: too slow');
  });
});

describe('fillWaitingHindiNames', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('menumesh.hindiNamesPausedUntil')];
  });

  it('leaves the names alone for 30 minutes after a run that found every provider down', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    const { admin, calls } = fakeAdmin(() => [dish('a')]);
    const down = vi.fn(
      async () => new Response('busy', { status: 503 }),
    ) as unknown as typeof fetch;
    const { run } = stoppableRun();
    const options = { lanes: 1, run, providers: [primary, fallback], fetchImpl: down };

    await expect(fillWaitingHindiNames(admin, options)).resolves.toMatchObject({
      stopped: 'unavailable',
    });
    expect(calls('menu_hindi_names_lease')).toHaveLength(1);

    // Each lease writes its row: until the pause ends, the minute job leases nothing.
    vi.setSystemTime(new Date('2026-11-09T10:29:59Z'));
    await expect(fillWaitingHindiNames(admin, options)).resolves.toEqual({ skipped: 'paused' });
    expect(calls('menu_hindi_names_lease')).toHaveLength(1);

    vi.setSystemTime(new Date('2026-11-09T10:30:00Z'));
    await expect(fillWaitingHindiNames(admin, options)).resolves.toMatchObject({
      stopped: 'unavailable',
    });
    expect(calls('menu_hindi_names_lease')).toHaveLength(2);
  });

  it('leases at most 2,000 names a run', async () => {
    let made = 0;
    const { admin, calls } = fakeAdmin((limit) =>
      made >= 2_500 ? [] : Array.from({ length: limit }, () => dish(`d${made++}`)),
    );
    // A failure taken for the names' doing: each batch is counted as tried.
    const fetchImpl = vi.fn(
      async () => new Response('too many names', { status: 422 }),
    ) as unknown as typeof fetch;
    const { run } = stoppableRun();

    await expect(
      fillWaitingHindiNames(admin, { run, providers: [primary], fetchImpl }),
    ).resolves.toEqual({ leased: 2_000, stored: 0 });
    expect(calls('menu_hindi_names_settle')).toHaveLength(20);
  });

  it('warns once, with the end of the pause, and logs nothing for a call it skips', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin } = fakeAdmin(() => [dish('a')]);
    const down = vi.fn(
      async () => new Response('busy', { status: 503 }),
    ) as unknown as typeof fetch;
    const { run } = stoppableRun();
    const options = { lanes: 1, run, providers: [primary, fallback], fetchImpl: down };

    await fillWaitingHindiNames(admin, options);
    // Each reader's answer, the outage, and the pause with its end.
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      '[hindi-names] commandcode answered 503: busy',
      '[hindi-names] openrouter answered 503: busy',
      '[hindi-names] every provider is down: the run ends, its names not counted as tried',
      '[hindi-names] the minute job leaves the names alone until 2026-11-09T10:30:00.000Z',
    ]);

    // A line for each call it skips would be a line a minute through an outage.
    vi.setSystemTime(new Date('2026-11-09T10:10:00Z'));
    await expect(fillWaitingHindiNames(admin, options)).resolves.toEqual({ skipped: 'paused' });
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('sets no pause after a run whose other batches were written', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    let made = 0;
    const { admin, calls } = fakeAdmin((limit) =>
      made >= 1_000 ? [] : Array.from({ length: limit }, () => dish(`d${made++}`)),
    );
    // One reader that takes 4 calls at once: the fifth of the lanes' calls is turned away.
    let asked = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      ++asked === 5
        ? new Response('rate limited', { status: 429 })
        : writeAll(JSON.parse(String(init?.body)) as Record<string, unknown>),
    ) as unknown as typeof fetch;
    const { run } = stoppableRun();
    const options = { run, providers: [primary], fetchImpl };

    // The other lanes write their batches, and then the run ends.
    await expect(fillWaitingHindiNames(admin, options)).resolves.toMatchObject({
      stopped: 'unavailable',
    });
    expect(calls('menu_hindi_names_settle').length).toBeGreaterThan(0);

    // The next minute's run leases again: every name is leased, and every batch but the one
    // turned away is written.
    vi.setSystemTime(new Date('2026-11-09T10:01:00Z'));
    await expect(fillWaitingHindiNames(admin, options)).resolves.not.toHaveProperty('skipped');
    expect(made).toBe(1_000);
    expect(calls('menu_hindi_names_settle')).toHaveLength(9);
  });

  it('sets no pause after a run that ended any other way', async () => {
    const { admin, calls } = fakeAdmin([[dish('a')], [], [dish('b')]]);
    const { fetchImpl } = fakeFetch(
      completion([{ n: 0, hindi: 'डिश ए' }]),
      completion([{ n: 0, hindi: 'डिश बी' }]),
    );
    const { run } = stoppableRun();
    const options = { lanes: 1, run, providers: [primary], fetchImpl };

    await expect(fillWaitingHindiNames(admin, options)).resolves.toEqual({ leased: 1, stored: 1 });
    await expect(fillWaitingHindiNames(admin, options)).resolves.toEqual({ leased: 1, stored: 1 });
    expect(calls('menu_hindi_names_lease')).toHaveLength(4);
  });

  it.each([
    ['as the only reader', [fallback]],
    ['after the primary answered 503', [primary, fallback]],
  ])(
    'settles a batch that OpenRouter blocks as a prompt injection, %s, and sets no pause',
    async (_, providers) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { admin, calls } = fakeAdmin([[dish('a')]]);
      const fetchImpl = vi.fn(async (url: string | URL | Request) =>
        String(url).startsWith(fallback.baseUrl)
          ? forbidden(openRouter403.injection)
          : new Response('busy', { status: 503 }),
      ) as unknown as typeof fetch;
      const { run } = stoppableRun();
      const options = { lanes: 1, run, providers, fetchImpl };

      // Counted as tried, so that it cannot be leased first and end every run.
      await expect(fillWaitingHindiNames(admin, options)).resolves.toEqual({
        leased: 1,
        stored: 0,
      });
      expect(calls('menu_hindi_names_settle')).toEqual([
        { p_names: [{ kind: 'item', id: 'a', name: 'Dish a' }] },
      ]);
      // No outage and no pause in the logs, and the answer's message as it came, without its fields.
      expect(warn.mock.calls.map(([line]) => line)).toEqual([
        ...(providers.length > 1 ? ['[hindi-names] commandcode answered 503: busy'] : []),
        '[hindi-names] openrouter answered 403: Request blocked: prompt injection patterns detected',
      ]);

      // The next minute's run leases again.
      vi.setSystemTime(new Date('2026-11-09T10:01:00Z'));
      await expect(fillWaitingHindiNames(admin, options)).resolves.toEqual({
        leased: 0,
        stored: 0,
      });
      expect(calls('menu_hindi_names_lease')).toHaveLength(3);
    },
  );

  it("settles nothing and pauses when OpenRouter's 403 is its data region and the primary is down", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    const { admin, calls } = fakeAdmin([[dish('a')]]);
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith(fallback.baseUrl)
        ? forbidden(openRouter403.dataRegion)
        : new Response('busy', { status: 503 }),
    ) as unknown as typeof fetch;
    const { run } = stoppableRun();
    const options = { lanes: 1, run, providers: [primary, fallback], fetchImpl };

    // Its message names a guardrail, but no names can cause it: an outage.
    await expect(fillWaitingHindiNames(admin, options)).resolves.toEqual({
      leased: 1,
      stored: 0,
      stopped: 'unavailable',
    });
    expect(calls('menu_hindi_names_settle')).toEqual([]);

    vi.setSystemTime(new Date('2026-11-09T10:01:00Z'));
    await expect(fillWaitingHindiNames(admin, options)).resolves.toEqual({ skipped: 'paused' });
    expect(calls('menu_hindi_names_lease')).toHaveLength(1);
  });
});

describe('queueHindiNames', () => {
  it('does nothing without a provider', () => {
    queueHindiNames('rest-1');
    expect(next.tasks).toHaveLength(0);
  });

  it("fills the restaurant's names after the response", async () => {
    config.providers = [primary];
    const { admin, calls } = fakeAdmin([]);
    db.admin = admin;

    queueHindiNames('rest-1');
    expect(next.tasks).toHaveLength(1);
    expect(calls('menu_hindi_names_lease')).toHaveLength(0);

    await next.tasks[0]!();
    // Three lanes, and the whole of 300 names asked for in 100s.
    const leases = calls('menu_hindi_names_lease');
    expect(leases).toHaveLength(3);
    for (const lease of leases) {
      expect(lease).toEqual({ p_restaurant_id: 'rest-1', p_limit: 100, p_lease_seconds: 300 });
    }
  });

  it('logs a failure instead of throwing it', async () => {
    config.providers = [primary];
    db.admin = fakeAdmin([], () => ({ data: null, error: { message: 'connection lost' } })).admin;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    queueHindiNames('rest-1');
    await expect(next.tasks[0]!()).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith('[hindi-names] fill failed', expect.any(Error));
  });
});
