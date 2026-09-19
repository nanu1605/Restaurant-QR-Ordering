/**
 * A minimal OpenAI-compatible Chat Completions client over fetch
 * (docs/DECISIONS.md P7-12). It serves any provider with /chat/completions:
 * the Command Code Provider API and OpenRouter by default. Server-side only
 * (it carries an API key), but kept free of server imports so tests can run it.
 */

export type VisionProvider = {
  /** Short label for logs and the import record, e.g. "commandcode". */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type ChatMessage =
  | { role: 'system' | 'assistant'; content: string }
  | {
      role: 'user';
      content:
        | string
        | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
    };

export type ChatUsage = {
  inputTokens: number;
  outputTokens: number;
  /** US dollars, when the provider reports it (OpenRouter does). */
  costUsd: number | null;
};

export type ChatResult = {
  content: string;
  /** The model that answered, as the provider reports it. */
  model: string;
  usage: ChatUsage;
};

export type ProviderErrorKind = 'network' | 'timeout' | 'http' | 'response';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status: number | null = null,
    /** Tokens the failed call still used (a cut-off reply). */
    readonly usage: ChatUsage | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type JsonSchemaFormat = { name: string; schema: Record<string, unknown> };

const MAX_ERROR_TEXT = 300;

function providerHeaders(provider: VisionProvider): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
  };
  // Command Code: zero data retention and no training on these photos.
  if (new URL(provider.baseUrl).hostname.endsWith('commandcode.ai')) headers['x-cmd-zdr'] = '1';
  return headers;
}

function readUsage(value: unknown): ChatUsage {
  const usage = (value ?? {}) as Record<string, unknown>;
  const number = (key: string) =>
    typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? (usage[key] as number) : null;
  return {
    inputTokens: Math.max(0, Math.round(number('prompt_tokens') ?? 0)),
    outputTokens: Math.max(0, Math.round(number('completion_tokens') ?? 0)),
    costUsd: number('cost'),
  };
}

function readContent(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? (part.text as string) : ''))
      .join('');
  }
  return '';
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message =
      typeof body.error === 'string'
        ? body.error
        : typeof body.error?.message === 'string'
          ? body.error.message
          : typeof body.message === 'string'
            ? body.message
            : text;
    return message.slice(0, MAX_ERROR_TEXT);
  } catch {
    return text.slice(0, MAX_ERROR_TEXT);
  }
}

export async function chatCompletion({
  provider,
  messages,
  jsonSchema,
  timeoutMs,
  maxTokens = 16_384,
  fetchImpl = fetch,
}: {
  provider: VisionProvider;
  messages: ChatMessage[];
  /** Ask for structured output; null sends none (a provider that refuses it). */
  jsonSchema: JsonSchemaFormat | null;
  timeoutMs: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
    stream: false,
  };
  if (jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: jsonSchema.name, strict: true, schema: jsonSchema.schema },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await call(provider, body, jsonSchema, controller, fetchImpl);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderError(`${provider.name} did not answer in time`, 'timeout');
    }
    throw error;
  } finally {
    // Cleared only once the body has been read too, so a provider that sends
    // headers and then stalls still runs out of time.
    clearTimeout(timer);
  }
}

async function call(
  provider: VisionProvider,
  body: Record<string, unknown>,
  jsonSchema: JsonSchemaFormat | null,
  controller: AbortController,
  fetchImpl: typeof fetch,
): Promise<ChatResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: providerHeaders(provider),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw error;
    throw new ProviderError(
      `${provider.name} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      'network',
    );
  }

  if (!response.ok) {
    throw new ProviderError(
      `${provider.name} answered ${response.status}: ${await errorText(response)}`,
      'http',
      response.status,
    );
  }

  let json: {
    choices?: Array<{ message?: unknown; finish_reason?: unknown }>;
    usage?: unknown;
    model?: unknown;
  };
  try {
    json = (await response.json()) as typeof json;
  } catch {
    throw new ProviderError(`${provider.name} sent a reply that is not JSON`, 'response');
  }

  const usage = readUsage(json.usage);
  const choice = json.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new ProviderError(
      `${provider.name} stopped before the reply was complete`,
      'response',
      null,
      usage,
    );
  }
  const content = readContent(choice?.message);
  if (!content.trim()) {
    throw new ProviderError(`${provider.name} sent an empty reply`, 'response', null, usage);
  }
  return {
    content,
    model: typeof json.model === 'string' && json.model ? json.model : provider.model,
    usage,
  };
}
