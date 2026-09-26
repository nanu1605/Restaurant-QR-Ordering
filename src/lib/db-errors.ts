import { formatINR } from './money';

/**
 * Maps error codes raised by database functions (spec §9.3: errcode P0001 with a
 * CODE message, context in DETAIL) to messages that say what happened and what
 * to do next (spec §13). Customers get their own wording (CUSTOMER_MESSAGES).
 */

export type DbErrorLike = {
  code?: string;
  message: string;
  details?: string | null;
};

type Message = string | ((detail: string) => string);

function tableList(labels: string): string {
  const names = labels
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
  return names.length === 1 ? `Table ${names[0]}` : `Tables ${names.join(', ')}`;
}

const MESSAGES: Record<string, Message> = {
  FORBIDDEN: "You don't have permission to do that.",
  NOT_FOUND: 'That no longer exists. Refresh the page and try again.',
  INVALID_INPUT: 'Some details are not valid. Check them and try again.',
  RESTAURANT_READ_ONLY:
    'Changes are paused while the subscription is inactive. Service actions still work.',
  PLAN_NOT_FOUND: 'Your restaurant has no plan yet. Contact support.',
  PLAN_LIMIT_TABLES: (max) =>
    `Your plan allows up to ${max} tables. Upgrade to Growth for unlimited tables.`,
  PLAN_LIMIT_STAFF: (max) =>
    `Your plan allows up to ${max} staff logins. Upgrade for more, or deactivate one first.`,
  FEATURE_NOT_IN_PLAN: "This feature isn't included in your plan.",

  // Menu import (spec §20A)
  IMPORT_LIMIT_REACHED:
    'Five photo imports a day is the limit. Try again tomorrow, or import a CSV file.',
  IMPORT_NOT_OPEN: 'This import is already finished. Open the menu to see it.',
  IMPORT_TOO_LARGE: 'An import can add at most 500 dishes. Skip some rows or split the menu.',
  FOOD_TYPE_UNCONFIRMED: 'Confirm that you checked the veg and non-veg marks first.',
  PAGE_ALREADY_READ: 'This page has been read already.',
  VARIANTS_DIFFER: 'The options do not match the ones on the menu.',

  // Super-admin (spec §13.4)
  MFA_REQUIRED: 'Enter the code from your authenticator app first.',
  RESTAURANT_NOT_FOUND: 'That restaurant no longer exists.',
  SUBSCRIPTION_NOT_FOUND: 'This restaurant has no subscription yet.',
  NOT_TRIALING: 'Only a trial can be extended. Record a payment instead.',
  PLAN_INACTIVE: 'That plan is switched off. Choose an active plan.',
  INVALID_PERIOD: 'Check the period: the last day is on or after the first, within 3 years.',
  MEMBER_NOT_FOUND: 'That owner login no longer exists.',
  SLUG_TAKEN: 'That restaurant code is taken. Choose another.',
  INVALID_SLUG: 'Restaurant codes are 3–32 lowercase letters, numbers or hyphens.',

  // Subscriptions (spec §14)
  RAZORPAY_MANAGED:
    'This restaurant pays by Razorpay autopay. Cancel autopay at period end first; the owner then subscribes to the new plan.',
  RAZORPAY_SUBSCRIPTION_LIVE: 'Autopay is already set up. Refresh the page to see it.',
  RESTAURANT_SUSPENDED: 'This restaurant is suspended. Contact support to restore it first.',
  WEBHOOK_NOT_FAILED: 'This event has already been processed. Refresh the page.',

  // Menu
  INVALID_CATEGORY_NAME: 'Enter a category name of up to 60 characters.',
  CATEGORY_NAME_TAKEN: (name) =>
    name ? `There is already a category called “${name}”.` : 'That category already exists.',
  CATEGORY_NOT_EMPTY: 'This category still has dishes. Choose where to move them first.',
  INVALID_ITEM_NAME: 'Enter a dish name of up to 80 characters.',
  INVALID_PRICE: 'Enter a price between ₹0 and ₹10,00,000.',
  INVALID_VARIANT_NAME: 'Give each option a name of up to 40 characters.',
  VARIANT_NAME_DUPLICATE: (name) => `Two options are called “${name}”. Give each its own name.`,
  ITEM_HAS_VARIANTS: 'This dish has options. Change the option prices instead.',
  INVALID_ADDON_GROUP_NAME: 'Enter a group name of up to 60 characters.',
  ADDON_GROUP_NAME_DUPLICATE: (name) =>
    name ? `There is already an add-on group called “${name}”.` : 'That group already exists.',
  INVALID_ADDON_NAME: 'Give each add-on a name of up to 40 characters.',
  ADDON_NAME_DUPLICATE: (name) => `Two add-ons are called “${name}”. Give each its own name.`,
  INVALID_IMAGE_PATH: 'The image could not be saved. Upload it again.',

  // Tables
  INVALID_TABLE_LABEL: 'Table names must be 1–30 characters.',
  TABLE_LABEL_DUPLICATE: 'The same table name appears twice.',
  TABLE_LABEL_TAKEN: (label) => `There is already a table called “${label}”.`,
  TABLE_HAS_OPEN_SESSION: 'This table has guests right now. Bill or close it first.',
  TABLE_BUSY: (label) =>
    label
      ? `Table ${label} has guests now. Choose another table.`
      : 'That table has guests now. Choose another table.',

  // Staff logins
  ROLE_NOT_ALLOWED: "You can't manage logins with that role.",
  CANNOT_CHANGE_SELF: "You can't change your own login here.",
  USERNAME_TAKEN: (username) => `The username “${username}” is already taken.`,
  INVALID_USERNAME: 'Usernames are 3–30 lowercase letters, numbers or underscores.',
  INVALID_DISPLAY_NAME: 'Enter a name of up to 80 characters.',
  USER_ALREADY_MEMBER: 'This account already belongs to a restaurant.',
  USER_NOT_FOUND: 'The login could not be created. Try again.',

  // Waiters
  INVALID_WAITER_NAME: "Enter the waiter's name (up to 80 characters).",
  INVALID_PHONE: 'Enter a 10-digit mobile number.',
  WAITER_CODE_TAKEN: (code) => `Employee code “${code}” belongs to another waiter.`,
  LOGIN_NOT_WAITER: 'Only active waiter logins can be linked.',
  LOGIN_ALREADY_LINKED: 'That login is already linked to another waiter.',
  WAITER_HAS_OPEN_TABLES: (labels) => `Reassign ${tableList(labels)} first.`,

  // Settings
  UPI_VPA_REQUIRED: 'Enter your UPI ID to show a UPI QR on bills.',

  // Live orders (worker panel and admin Live orders)
  SESSION_NOT_OPEN: 'This table was billed or closed in the meantime. The board is up to date now.',
  ORDER_NOT_PENDING: 'Someone already approved or rejected this order.',
  ORDER_NOT_ACCEPTED:
    "This order can't be changed: it's waiting for approval, was rejected or was removed.",
  ORDER_NOT_ACTIVE: 'This order was already rejected or removed.',
  ITEM_NOT_ACTIVE: 'This dish was already cancelled or removed.',
  INVALID_STATUS_CHANGE: 'This dish has already moved on. The board is up to date now.',
  REQUIRES_MANAGER:
    'Ask a manager: only managers can remove served dishes or close a table that has orders.',
  REASON_REQUIRED: 'Choose or type a reason.',
  WAITER_BUSY: (labels) =>
    labels ? `This waiter is already handling ${tableList(labels)}.` : 'This waiter is busy.',
  WAITER_NOT_AVAILABLE: (name) => `${name || 'This waiter'} isn't on duty. Choose someone else.`,
  ORDERING_UNAVAILABLE:
    'New orders are paused while the subscription is inactive. Open tables can still be served.',
  ITEM_UNAVAILABLE: 'Some dishes are out of stock or no longer on the menu. We took them out.',

  // Billing
  ORDERS_WAITING: 'Approve or reject the waiting order first.',
  NOTHING_TO_BILL: 'This table has nothing to bill. Close it without a bill instead.',
  WAITER_REQUIRED: 'Assign a waiter before generating the bill.',
  ALREADY_BILLED: 'This table was already billed.',
  BILL_CHANGED: 'The bill changed while you were checking it. Check the new total and try again.',
  BILL_VOID: 'This bill was voided.',
  BILL_ALREADY_PAID: 'A payment was already recorded for this bill.',
  PAYMENT_MISMATCH: (total) =>
    /^\d+$/.test(total)
      ? `Payments must add up to ${formatINR(Number(total))}.`
      : 'Payments must add up to the bill total.',
  REOPEN_NOT_ALLOWED: (why) =>
    why === 'table_busy'
      ? "New guests have opened this table, so it can't be reopened. Void the bill without reopening."
      : why === 'table_inactive'
        ? "This table is switched off, so it can't be reopened. Void the bill without reopening."
        : 'The time to reopen this table has passed. Void the bill without reopening.',
};

export const GENERIC_ERROR = 'Something went wrong. Try again.';

/** The CODE of a business-rule error, or null for anything else. */
export function dbErrorCode(error: DbErrorLike): string | null {
  if (error.code === 'P0001') return error.message;
  if (error.code === '42501') return 'FORBIDDEN';
  return null;
}

function resolve(messages: Record<string, Message>, error: DbErrorLike): string | null {
  const code = dbErrorCode(error);
  if (!code) return null;
  const message = messages[code];
  if (message === undefined) return null;
  return typeof message === 'function' ? message(error.details?.trim() ?? '') : message;
}

/** Human message for a database error, or null if the error is unexpected. */
export function dbErrorMessage(error: DbErrorLike): string | null {
  return resolve(MESSAGES, error);
}

// Customer panel (spec §13.1): plain words, no staff jargon, what to do next.
const CUSTOMER_MESSAGES: Record<string, Message> = {
  TABLE_NOT_FOUND: 'This QR code isn’t working any more. Please ask the staff for help.',
  ORDERING_UNAVAILABLE: 'Online ordering is unavailable right now. Please order with our staff.',
  ITEM_UNAVAILABLE: 'Some dishes are no longer available. We took them out of your cart.',
  RATE_LIMITED: 'Please wait a moment before ordering again.',
  INVALID_INPUT: 'Something in your order needs checking. Look over your cart and try again.',
  NOT_FOUND: 'This dish is no longer on your table’s order. Refresh the page.',
  NOT_YOUR_ITEM: 'Only the phone that ordered this dish can cancel it.',
  ITEM_NOT_CANCELLABLE: 'The kitchen has already started this dish. Please ask the staff.',
  CANCEL_WINDOW_EXPIRED: 'It’s too late to cancel this dish. Please ask the staff.',
};

export const CUSTOMER_GENERIC_ERROR = 'Something went wrong. Please try again.';

/** Customer-facing message for a database error, or null if the error is unexpected. */
export function customerErrorMessage(error: DbErrorLike): string | null {
  return resolve(CUSTOMER_MESSAGES, error);
}
