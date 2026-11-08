import 'server-only';

import {
  chatCompletion,
  ProviderError,
  type ChatMessage,
  type ChatUsage,
  type VisionProvider,
} from '@/lib/vision/openai-compatible';

import { pageExtractionSchema, type PageExtraction } from './draft';
import {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_USER_PROMPT,
  retryPrompt,
} from './prompt';

/**
 * Reads one menu page (spec §20A.2, docs/DECISIONS.md P7-12, P7-13). Providers
 * are tried in order: an error (unreachable, timeout, any HTTP error) moves the
 * page to the next one. A reply that doesn't match the schema is retried once
 * on the same provider with the problem appended; a second bad reply fails the
 * page. Tokens and cost add up over every call made. A call isn't started with
 * less than MIN_CALL_MS left of the page's time (docs/DECISIONS.md VPS-5).
 */

/** One call to a reader. */
export const PAGE_TIMEOUT_MS = 40_000;
/**
 * Everything for one page, retry and fallback included, counted from the start of its server
 * action, so that the action answers before Cloudflare cuts a request at 100 s (P7-15, VPS-5).
 */
export const PAGE_DEADLINE_MS = 85_000;
/**
 * A call isn't started with less time than this left: few pages are read faster, and a call
 * that is cut off is still paid for.
 */
export const MIN_CALL_MS = 15_000;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** US dollars per million tokens, for providers that don't report the cost (P7-13). */
const PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  // OpenRouter list price, checked 2026-09-19; Command Code charges the same.
  'google/gemini-3.8-flash': { input: 0.75, output: 3.75 },
};

export const UNREADABLE_PAGE =
  'This page could not be read. Try a sharper photo taken straight on, of this page only.';
export const READER_UNAVAILABLE =
  'The menu reader is not answering right now. Try this page again in a few minutes.';

/**
 * A failed page's error as the review shows it. By then the reading went on without the page, so
 * the reader's "try this page again" no longer applies (docs/DECISIONS.md VPS-30).
 */
export function reviewPageError(error: string | null | undefined): string {
  return error === READER_UNAVAILABLE
    ? 'The menu reader was not answering.'
    : (error ?? 'Unknown error');
}

export type PageOutcome = {
  status: 'done' | 'failed';
  result: PageExtraction | null;
  /** The last reply as received (parsed JSON when it was JSON). */
  raw: unknown;
  error: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Null when any call's cost is unknown. */
  costPaise: number | null;
};

export function callCostPaise(model: string, usage: ChatUsage, usdToInr: number): number | null {
  let usd = usage.costUsd;
  if (usd === null) {
    const price = PRICES_USD_PER_MTOK[model];
    if (!price) return null;
    usd = (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  }
  return Math.round(usd * usdToInr * 100);
}

/** The JSON object in a reply, tolerating code fences or a sentence around it. */
export function parseReplyJson(content: string): unknown {
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function issuesText(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || 'reply'}: ${issue.message}`)
    .join('; ');
}

export async function extractPage({
  imageJpegBase64,
  providers,
  usdToInr,
  fetchImpl,
  now = () => Date.now(),
  timeoutMs = PAGE_TIMEOUT_MS,
  deadlineMs = PAGE_DEADLINE_MS,
}: {
  imageJpegBase64: string;
  providers: VisionProvider[];
  usdToInr: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  deadlineMs?: number;
}): Promise<PageOutcome> {
  const started = now();
  const outcome: PageOutcome = {
    status: 'failed',
    result: null,
    raw: null,
    error: READER_UNAVAILABLE,
    provider: null,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    costPaise: 0,
  };
  const count = (model: string, usage: ChatUsage) => {
    outcome.inputTokens += usage.inputTokens;
    outcome.outputTokens += usage.outputTokens;
    const cost = callCostPaise(model, usage, usdToInr);
    outcome.costPaise =
      cost === null || outcome.costPaise === null ? null : outcome.costPaise + cost;
  };
  const baseMessages: ChatMessage[] = [
    { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: EXTRACTION_USER_PROMPT },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageJpegBase64}` } },
      ],
    },
  ];

  for (const provider of providers) {
    let messages = baseMessages;
    let useSchema = true;
    let badReplies = 0;
    let called = false;

    while (true) {
      const callAt = now();
      const remaining = deadlineMs - (callAt - started);
      if (remaining < MIN_CALL_MS) {
        // A bad reply that can't be asked again is an unreadable page, not a reader too slow.
        return badReplies > 0 ? { ...outcome, error: UNREADABLE_PAGE } : outcome;
      }
      // Only a reader that was called is recorded as the page's provider.
      if (!called) {
        outcome.provider = provider.name;
        outcome.model = provider.model;
        called = true;
      }

      let reply;
      try {
        reply = await chatCompletion({
          provider,
          messages,
          jsonSchema: useSchema ? EXTRACTION_JSON_SCHEMA : null,
          timeoutMs: Math.min(timeoutMs, remaining),
          fetchImpl,
        });
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        if (error.usage) count(provider.model, error.usage);
        // A provider that doesn't take structured output: ask again without it.
        if (
          useSchema &&
          error.kind === 'http' &&
          error.status === 400 &&
          /response_format|json_schema|structured/i.test(error.message)
        ) {
          useSchema = false;
          continue;
        }
        // The times, so that PAGE_TIMEOUT_MS can be tuned from the logs.
        const failedAt = now();
        console.warn(
          `Menu import: ${error.message} (the call took ${seconds(failedAt - callAt)}, the page ${seconds(failedAt - started)} so far)`,
        );
        outcome.error = error.kind === 'response' ? UNREADABLE_PAGE : READER_UNAVAILABLE;
        break; // next provider
      }

      count(reply.model, reply.usage);
      outcome.model = reply.model;
      const json = parseReplyJson(reply.content);
      outcome.raw = json ?? reply.content;
      const parsed = pageExtractionSchema.safeParse(json);
      if (parsed.success) {
        return { ...outcome, status: 'done', result: parsed.data, error: null };
      }

      badReplies += 1;
      if (badReplies >= 2) {
        return { ...outcome, status: 'failed', error: UNREADABLE_PAGE };
      }
      messages = [
        ...baseMessages,
        { role: 'assistant', content: reply.content.slice(0, 20_000) },
        {
          role: 'user',
          content: retryPrompt(
            json === undefined ? 'the reply is not JSON' : issuesText(parsed.error),
          ),
        },
      ];
    }
  }
  return outcome;
}
