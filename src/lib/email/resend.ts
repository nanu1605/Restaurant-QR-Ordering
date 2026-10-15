import { createHmac } from 'node:crypto';

import { getServerEnv } from '@/lib/env.server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Sends email through Resend's REST API over fetch (spec §14.6,
 * docs/DECISIONS.md P8-12): every email the app sends, each logged in
 * email_log (SA-87). Server-side only: it carries the API key.
 */

export type EmailConfig = {
  apiKey: string;
  from: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Records each send in email_log (docs/DECISIONS.md SA-87). */
  log?: (send: EmailSend) => PromiseLike<unknown>;
};

/** What the log keeps of one send: never the subject or body. */
export type EmailSend = {
  kind: string;
  to: string[];
  status: 'sent' | 'failed' | 'duplicate';
  provider_id: string | null;
  http_status: number | null;
  error: string | null;
};

/** The Resend account from the environment, or null when email is off. */
export function emailConfig(): EmailConfig | null {
  const env = getServerEnv();
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return null;
  return {
    apiKey: env.RESEND_API_KEY,
    from: env.EMAIL_FROM,
    baseUrl: env.RESEND_API_URL,
    log: logEmail,
  };
}

/** A keyed hash of an address: the log's, and its lookup's (SA-87). */
export const hashEmail = (address: string, secret = getServerEnv().CUSTOMER_COOKIE_SECRET) =>
  createHmac('sha256', secret).update(`email:${address.trim().toLowerCase()}`).digest('hex');

async function logEmail({ to, ...send }: EmailSend) {
  const { error } = await createAdminClient()
    .from('email_log')
    .insert({ ...send, recipient_hashes: to.map((address) => hashEmail(address)) });
  if (error) throw new Error(error.message);
}

// Resend may echo an address in its refusal: never in a message, so not in
// the log or Sentry either.
const scrub = (message: string) => message.replace(/[^\s@<>"',:]+@[^\s@<>"',]+/g, '[email]');

/** Text made safe inside HTML email bodies. */
export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

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

/** Sends one email and logs it; returns Resend's id. */
export async function sendEmail(config: EmailConfig, email: Email): Promise<string> {
  let id: string | null = null;
  let failure: EmailError | null = null;
  try {
    id = await post(config, email);
    return id;
  } catch (error) {
    failure = error as EmailError;
    throw error;
  } finally {
    // A send that can't be logged still counts: only the log misses it.
    await Promise.resolve(
      config.log?.({
        kind: email.idempotencyKey.split('/')[0]!,
        to: email.to,
        // 409: Resend already sent one with this key (the digest's rerun, SA-31).
        status: id ? 'sent' : failure?.status === 409 ? 'duplicate' : 'failed',
        provider_id: id,
        http_status: failure?.status ?? null,
        error: failure && failure.status !== 409 ? failure.message.slice(0, 500) : null,
      }),
    ).catch((error: unknown) => console.error('[email] could not log a send', error));
  }
}

async function post(config: EmailConfig, email: Email): Promise<string> {
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
      const detail = scrub(await response.text().catch(() => '')).slice(0, 300);
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
