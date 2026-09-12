/**
 * Order limits shared by the cart, the server actions and the database
 * (spec §8.5, §9.3). Plain constants, so the customer bundle stays small.
 */
export const MAX_ORDER_LINES = 30;
export const MAX_LINE_QUANTITY = 20;
export const MAX_LINE_NOTE = 120;
export const MAX_ORDER_NOTE = 200;

export const QR_TOKEN_PATTERN = /^[A-Za-z0-9]{16}$/;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/** Customer pages poll the orders page this often while it is visible (spec §12). */
export const SESSION_POLL_MS = 10_000;
