// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountMenu } from '@/components/shared/account-menu';
import { StaffLangProvider } from '@/features/orders/staff-lang';
import { STAFF_STRINGS } from '@/features/orders/strings';
import { setMyLanguage } from '@/features/staff/actions';
import type { ActionResult } from '@/lib/action-result';

vi.mock('next/navigation', () => ({ usePathname: () => '/staff' }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock('@/features/staff/actions', () => ({ setMyLanguage: vi.fn() }));
vi.mock('@/features/theme/theme-switch', () => ({ ThemeRadioGroup: () => null }));

// The worker panel's language switch, on a page from an older build (docs/DECISIONS.md VPS-8).

const hi = STAFF_STRINGS.hi;

/** A Hindi worker picks English; the server's answer is in the caller's hands. */
async function switchToEnglish() {
  const server = {} as {
    answer: (result: ActionResult) => void;
    fail: (error: unknown) => void;
  };
  vi.mocked(setMyLanguage).mockReturnValue(
    new Promise<ActionResult>((resolve, reject) => {
      server.answer = resolve;
      server.fail = reject;
    }),
  );
  render(
    <StaffLangProvider lang="hi">
      <AccountMenu userName="Ravi" roleLabel={hi.roles.waiter} />
    </StaffLangProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Ravi/ }));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'English' }));
  await waitFor(() => expect(setMyLanguage).toHaveBeenCalledWith('en'));
  return server;
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
});

describe('the language switch in the account menu', () => {
  it('shows no error for an older build’s answer, which the refresh notice explains', async () => {
    const server = await switchToEnglish();
    await act(async () =>
      server.fail(new UnrecognizedActionError('Server Action "7f0a" not found')),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says the connection failed when the request did not get through', async () => {
    const server = await switchToEnglish();
    await act(async () => server.fail(new TypeError('Failed to fetch')));
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(hi.network);
  });

  it('gives the server’s refusal in the panel’s language', async () => {
    const server = await switchToEnglish();
    const refusal = { ok: false as const, error: 'Nope.' };
    await act(async () => server.answer(refusal));
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(hi.refusal(refusal));
  });
});
