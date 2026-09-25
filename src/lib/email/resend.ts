import { getServerEnv } from '@/lib/env.server';

/**
 * Sends email through Resend's REST API over fetch (spec §14.6,
 * docs/DECISIONS.md P8-12): subscription reminders only, for now.
 * Server-side only: it carries the API key.
 */

export type EmailConfig = {
  apiKey: string;
  from: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** The Resend account from the environment, or null when email is off. */
export function emailConfig(): EmailConfig | null {
  const env = getServerEnv();
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return null;
  return { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, baseUrl: env.RESEND_API_URL };
}

export class EmailError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'EmailError';
  }
}

export type Email = {
  to: string[];
  subject: string;
  html: string;
  text: string;
  /** Resend sends one email per key (for 24 hours), however often it is asked. */
  idempotencyKey: string;
};

const DEFAULT_TIMEOUT_MS = 15_000;

/** Sends one email; returns Resend's id. */
export async function sendEmail(config: EmailConfig, email: Email): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await (config.fetchImpl ?? fetch)(
      `${config.baseUrl.replace(/\/+$/, '')}/emails`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': email.idempotencyKey,
        },
        body: JSON.stringify({
          from: config.from,
          to: email.to,
          subject: email.subject,
          html: email.html,
          text: email.text,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new EmailError(`Resend answered ${response.status}: ${detail}`, response.status);
    }
    const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof body?.id !== 'string') throw new EmailError('Resend sent a reply without an id');
    return body.id;
  } catch (error) {
    if (error instanceof EmailError) throw error;
    throw new EmailError(
      controller.signal.aborted
        ? 'Resend did not answer in time'
        : `Resend could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
