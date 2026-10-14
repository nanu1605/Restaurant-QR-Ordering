/**
 * Business-date ranges from page URLs, shared by Total orders and Reports.
 * Dates are 'YYYY-MM-DD' business dates; the database turns them into times
 * with the restaurant's timezone and business-day start (docs/DECISIONS.md
 * P5-12, P6-10), so nothing here needs a timezone.
 */

export type SearchParams = Record<string, string | string[] | undefined>;

/** The first value of a search param, trimmed; undefined when empty. */
export function firstParam(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  const text = (Array.isArray(value) ? value[0] : value)?.trim();
  return text ? text : undefined;
}

/** The longest range a page shows at once (the database checks it too). */
export const MAX_RANGE_DAYS = 366;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in 'YYYY-MM-DD' form (2026-02-30 isn't). */
export function isDate(text: string | undefined): text is string {
  return !!text && DATE.test(text) && addDays(text, 0) === text;
}

/** 'YYYY-MM-DD' plus whole days (calendar arithmetic, no timezones). */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type DateRange = { from?: string; to?: string };

/**
 * The date range in a page URL, plus a note when it had to be changed.
 * Malformed dates are dropped rather than failing the page (the page then
 * shows today); a range longer than a year is cut to a year.
 */
export function readDateRange(
  params: SearchParams,
  pageName: string,
): { range: DateRange; notice: string | null } {
  const range: DateRange = {};
  let notice: string | null = null;
  const from = firstParam(params, 'from');
  const to = firstParam(params, 'to');
  if (isDate(from)) range.from = from;
  else if (from) notice = 'That date doesn’t exist, so today is shown.';
  if (range.from && isDate(to)) {
    if (to < range.from) {
      notice = 'The end date was before the start date, so one day is shown.';
    } else if (daysBetween(range.from, to) > MAX_RANGE_DAYS) {
      range.to = addDays(range.from, MAX_RANGE_DAYS);
      notice = `${pageName} shows up to a year at a time, so the range was shortened.`;
    } else {
      range.to = to;
    }
  } else if (range.from && to) {
    notice = 'That end date doesn’t exist, so one day is shown.';
  }
  return { range, notice };
}

export type DatePreset = { key: string; label: string; from: string; to: string };

/** Quick ranges relative to the restaurant's current business day. */
export function datePresets(today: string): DatePreset[] {
  return [
    { key: 'today', label: 'Today', from: today, to: today },
    { key: 'yesterday', label: 'Yesterday', from: addDays(today, -1), to: addDays(today, -1) },
    { key: 'week', label: 'Last 7 days', from: addDays(today, -6), to: today },
    { key: 'month', label: 'This month', from: `${today.slice(0, 8)}01`, to: today },
  ];
}

/**
 * Ranges for MenuMesh's own money and growth numbers, in India calendar dates
 * (docs/SUPER_ADMIN_PLAN.md §1 Time). Quarters are calendar quarters, which
 * are also the financial year's.
 */
export function platformPresets(today: string): DatePreset[] {
  const month = Number(today.slice(5, 7));
  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const quarterMonth = String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0');
  return [
    { key: 'this_month', label: 'This month', from: monthStart, to: today },
    {
      key: 'last_month',
      label: 'Last month',
      from: `${lastMonthEnd.slice(0, 8)}01`,
      to: lastMonthEnd,
    },
    { key: 'last_30', label: 'Last 30 days', from: addDays(today, -29), to: today },
    {
      key: 'this_quarter',
      label: 'This quarter',
      from: `${today.slice(0, 5)}${quarterMonth}-01`,
      to: today,
    },
    { key: 'last_12_months', label: 'Last 12 months', from: addDays(today, -364), to: today },
  ];
}

/** `pathname` with these search params, leaving out empty ones. */
export function hrefWithParams(pathname: string, params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}
