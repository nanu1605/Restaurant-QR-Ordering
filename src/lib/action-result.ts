import type { z } from 'zod';

import { dbErrorCode, dbErrorMessage, GENERIC_ERROR, type DbErrorLike } from './db-errors';

/**
 * What every server action returns. Shaped for the UI (spec §13: errors say
 * what happened and what to do next), never raw database rows or errors. A
 * database refusal also carries its code and detail, so the worker panel can
 * say it in Hindi (docs/DECISIONS.md P11-17).
 */
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      fieldErrors?: Record<string, string>;
      code?: string;
      detail?: string;
    };

export function actionOk(): ActionResult<void>;
export function actionOk<T>(data: T): ActionResult<T>;
export function actionOk<T>(data?: T): ActionResult<T | undefined> {
  return { ok: true, data };
}

export function actionError(error: string, fieldErrors?: Record<string, string>) {
  return { ok: false as const, error, fieldErrors };
}

/** First message per field, keyed by dotted path (e.g. "variants.1.name"). */
export function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || 'form';
    fieldErrors[key] ??= issue.message;
  }
  return fieldErrors;
}

export function fromZodError(error: z.ZodError) {
  return actionError('Check the highlighted fields and try again.', fieldErrorsFrom(error));
}

/**
 * Business-rule errors become their message; anything unexpected is logged on
 * the server and shown as a generic error.
 */
export function fromDbError(error: DbErrorLike, context: string) {
  const message = dbErrorMessage(error);
  if (message) {
    return { ...actionError(message), code: dbErrorCode(error)!, detail: error.details ?? '' };
  }
  console.error(`${context} failed:`, error.code, error.message, error.details);
  return actionError(GENERIC_ERROR);
}
