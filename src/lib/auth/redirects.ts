import type { MemberRole } from './roles';

export type PanelPath = '/super' | '/admin' | '/staff';

export type AccessSummary = {
  isPlatformAdmin: boolean;
  /** Role in the user's (single, active) restaurant, if any. */
  role: MemberRole | null;
};

/** Where a user lands after login (spec §9.5). Null = no access anywhere. */
export function homePathFor({ isPlatformAdmin, role }: AccessSummary): PanelPath | null {
  if (isPlatformAdmin) return '/super';
  if (role === 'owner' || role === 'manager') return '/admin';
  if (role === 'waiter' || role === 'kitchen') return '/staff';
  return null;
}

/** Panels a user may open. */
export function allowedPanelsFor({ isPlatformAdmin, role }: AccessSummary): PanelPath[] {
  const panels: PanelPath[] = [];
  if (isPlatformAdmin) panels.push('/super');
  if (role === 'owner' || role === 'manager') panels.push('/admin', '/staff');
  if (role === 'waiter' || role === 'kitchen') panels.push('/staff');
  return panels;
}

const PANEL_PATHS: readonly PanelPath[] = ['/super', '/admin', '/staff'];
const LOCAL_ORIGIN = 'http://localhost';

/**
 * Sanitises a `next` redirect target: same-origin paths inside one of
 * `allowed` panels only, so login can never become an open redirect.
 * Returns the normalised path (+ query) or null.
 */
export function safeNextPath(
  next: unknown,
  allowed: readonly PanelPath[] = PANEL_PATHS,
): string | null {
  if (typeof next !== 'string' || next.length === 0 || next.length > 512) return null;
  // Absolute, protocol-relative and backslash tricks are never allowed.
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null;

  let url: URL;
  try {
    url = new URL(next, LOCAL_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== LOCAL_ORIGIN) return null;

  const inAllowedPanel = allowed.some(
    (panel) => url.pathname === panel || url.pathname.startsWith(`${panel}/`),
  );
  return inAllowedPanel ? `${url.pathname}${url.search}` : null;
}
