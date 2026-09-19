import { describe, expect, it, vi } from 'vitest';

import {
  callCostPaise,
  extractPage,
  parseReplyJson,
  READER_UNAVAILABLE,
  UNREADABLE_PAGE,
} from '@/features/menu-import/extract';
import { EXTRACTION_SYSTEM_PROMPT } from '@/features/menu-import/prompt';
import { menuImportProviders } from '@/features/menu-import/providers';
import { parseServerEnv } from '@/lib/env.server';
import type { VisionProvider } from '@/lib/vision/openai-compatible';

// Reading a menu page through the provider chain (spec §20A.2,
// docs/DECISIONS.md P7-12, P7-13), against a fake fetch.

const primary: VisionProvider = {
  name: 'commandcode',
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  apiKey: 'cc-key',
  model: 'google/gemini-3.8-flash',
};
const fallback: VisionProvider = {
  name: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1/',
  apiKey: 'or-key',
  model: 'google/gemini-3.8-flash',
};

const goodPage = {
  categories: [
    {
      name: 'Starters',
      confidence: 'high',
      items: [
        {
          name: 'Paneer Tikka',
          description: null,
          food_type: 'veg',
          price: 280,
          variants: [],
          confidence: 'high',
          notes: null,
        },
      ],
    },
  ],
  page_notes: null,
};

function completion(content: string, usage: Record<string, number> = {}, finish = 'stop') {
  return new Response(
    JSON.stringify({
      model: 'google/gemini-3.8-flash',
      choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
      usage: { prompt_tokens: 1000, completion_tokens: 400, ...usage },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function fakeFetch(...replies: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const reply = replies.shift();
    if (!reply) throw new Error('no more replies');
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const run = (fetchImpl: typeof fetch, providers = [primary, fallback]) =>
  extractPage({ imageJpegBase64: 'AAAA', providers, usdToInr: 96, fetchImpl });

describe('extractPage', () => {
  it('reads a page with structured output, the image and zero retention on Command Code', async () => {
    const { fetchImpl, calls } = fakeFetch(completion(JSON.stringify(goodPage)));
    const outcome = await run(fetchImpl);

    expect(outcome).toMatchObject({
      status: 'done',
      error: null,
      provider: 'commandcode',
      model: 'google/gemini-3.8-flash',
      inputTokens: 1000,
      outputTokens: 400,
    });
    expect(outcome.result?.categories[0]?.items[0]?.name).toBe('Paneer Tikka');
    // (1000 × 0.75 + 400 × 3.75) / 1e6 USD × 96 = ₹0.216 → 22 paise
    expect(outcome.costPaise).toBe(22);

    const [call] = calls;
    expect(call!.url).toBe('https://api.commandcode.ai/provider/v1/chat/completions');
    expect(call!.headers.Authorization).toBe('Bearer cc-key');
    expect(call!.headers['x-cmd-zdr']).toBe('1');
    expect(call!.body).toMatchObject({ model: 'google/gemini-3.8-flash', temperature: 0 });
    expect(call!.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'menu_page', strict: true },
    });
    const messages = call!.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({ role: 'system', content: EXTRACTION_SYSTEM_PROMPT });
    expect(JSON.stringify(messages[1]!.content)).toContain('data:image/jpeg;base64,AAAA');
  });

  it('retries a reply that does not match once, with the problem appended', async () => {
    const { fetchImpl, calls } = fakeFetch(
      completion('Here is the menu: {"categories": [{"name": "Starters"}]}'),
      completion(`\`\`\`json\n${JSON.stringify(goodPage)}\n\`\`\``),
    );
    const outcome = await run(fetchImpl);
    expect(outcome.status).toBe('done');
    expect(outcome.inputTokens).toBe(2000);
    expect(calls).toHaveLength(2);
    const retry = calls[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(retry.at(-2)!.role).toBe('assistant');
    expect(retry.at(-1)!.content).toContain('categories.0.items');
  });

  it('fails the page after two bad replies without trying the fallback', async () => {
    const { fetchImpl, calls } = fakeFetch(completion('not json'), completion('{"menu": []}'));
    const outcome = await run(fetchImpl);
    expect(outcome).toMatchObject({ status: 'failed', error: UNREADABLE_PAGE, inputTokens: 2000 });
    expect(outcome.raw).toEqual({ menu: [] });
    expect(calls).toHaveLength(2);
  });

  it('moves to the fallback when the primary errors', async () => {
    const { fetchImpl, calls } = fakeFetch(
      new Response(JSON.stringify({ error: { message: 'upstream overloaded' } }), { status: 503 }),
      completion(JSON.stringify(goodPage), { cost: 0.001 }),
    );
    const outcome = await run(fetchImpl);
    expect(outcome).toMatchObject({ status: 'done', provider: 'openrouter' });
    expect(calls[1]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[1]!.headers.Authorization).toBe('Bearer or-key');
    expect(calls[1]!.headers['x-cmd-zdr']).toBeUndefined();
    // The provider's reported cost wins: $0.001 × 96 = ₹0.096 → 10 paise.
    expect(outcome.costPaise).toBe(10);
  });

  it('says the reader is unavailable when every provider is down', async () => {
    const { fetchImpl } = fakeFetch(
      new TypeError('fetch failed'),
      new Response('Unauthorized', { status: 401 }),
    );
    const outcome = await run(fetchImpl);
    expect(outcome).toMatchObject({ status: 'failed', error: READER_UNAVAILABLE, costPaise: 0 });
  });

  it('asks again without structured output when a provider refuses it', async () => {
    const { fetchImpl, calls } = fakeFetch(
      new Response(JSON.stringify({ error: { message: 'response_format is not supported' } }), {
        status: 400,
      }),
      completion(JSON.stringify(goodPage)),
    );
    const outcome = await run(fetchImpl);
    expect(outcome.status).toBe('done');
    expect(calls[0]!.body.response_format).toBeDefined();
    expect(calls[1]!.body.response_format).toBeUndefined();
    expect(calls[1]!.url).toContain('commandcode');
  });

  it('counts the tokens of a cut-off reply and tries the next provider', async () => {
    const { fetchImpl } = fakeFetch(
      completion('{"categories": [', { completion_tokens: 16384 }, 'length'),
      completion(JSON.stringify(goodPage)),
    );
    const outcome = await run(fetchImpl);
    expect(outcome).toMatchObject({ status: 'done', provider: 'openrouter', outputTokens: 16784 });
  });

  it('times out a provider that does not answer', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const outcome = await extractPage({
      imageJpegBase64: 'AAAA',
      providers: [primary],
      usdToInr: 96,
      fetchImpl,
      timeoutMs: 20,
    });
    expect(outcome).toMatchObject({ status: 'failed', error: READER_UNAVAILABLE });
  });

  it('stops at the page deadline', async () => {
    let clock = 0;
    const { fetchImpl, calls } = fakeFetch(new Response('busy', { status: 500 }));
    const outcome = await extractPage({
      imageJpegBase64: 'AAAA',
      providers: [primary, fallback],
      usdToInr: 96,
      fetchImpl,
      now: () => (clock += 100_000),
      deadlineMs: 150_000,
    });
    expect(outcome.status).toBe('failed');
    expect(calls).toHaveLength(1);
  });
});

describe('callCostPaise', () => {
  it('uses the reported cost, then the price list, and is unknown otherwise', () => {
    const usage = { inputTokens: 2_000_000, outputTokens: 0 };
    expect(callCostPaise('any/model', { ...usage, costUsd: 0.5 }, 96)).toBe(4800);
    expect(callCostPaise('google/gemini-3.8-flash', { ...usage, costUsd: null }, 96)).toBe(14400);
    expect(callCostPaise('someone/unknown', { ...usage, costUsd: null }, 96)).toBeNull();
  });
});

describe('parseReplyJson', () => {
  it('reads plain JSON, fenced JSON and JSON inside a sentence', () => {
    expect(parseReplyJson('{"a": 1}')).toEqual({ a: 1 });
    expect(parseReplyJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseReplyJson('Sure! {"a": 1} Hope this helps.')).toEqual({ a: 1 });
    expect(parseReplyJson('no json here')).toBeUndefined();
  });
});

describe('menuImportProviders', () => {
  const base = { SUPABASE_SECRET_KEY: 'k', CUSTOMER_COOKIE_SECRET: 'x'.repeat(32) };

  it('defaults to Command Code first and OpenRouter as the fallback', () => {
    const providers = menuImportProviders(
      parseServerEnv({ ...base, MENU_IMPORT_API_KEY: 'a', MENU_IMPORT_FALLBACK_API_KEY: 'b' }),
    );
    expect(providers).toEqual([
      {
        name: 'commandcode',
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        apiKey: 'a',
        model: 'google/gemini-3.8-flash',
      },
      {
        name: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'b',
        model: 'google/gemini-3.8-flash',
      },
    ]);
  });

  it('is empty without keys, so photo import stays hidden', () => {
    expect(menuImportProviders(parseServerEnv({ ...base, MENU_IMPORT_MODEL: '' }))).toEqual([]);
    const env = parseServerEnv({ ...base, MENU_IMPORT_USD_INR: '' });
    expect(env.MENU_IMPORT_USD_INR).toBe(96);
  });
});
