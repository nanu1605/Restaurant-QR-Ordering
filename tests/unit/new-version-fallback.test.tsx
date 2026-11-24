// @vitest-environment jsdom
import { readFileSync } from 'node:fs';

import { fireEvent, render, screen } from '@testing-library/react';
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { Component, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AppError from '@/app/error';
import { HtmlLang } from '@/components/shared/html-lang';
import { ErrorFallback } from '@/features/new-version/components/error-fallback';
import { newVersionFound, refreshNow, useNewVersionNotice } from '@/features/new-version/notice';
import { NEW_VERSION_STRINGS } from '@/features/new-version/strings';
import { StaffLangProvider } from '@/features/orders/staff-lang';

// Only the notice's state is faked: usePageLang stays, and reads <html lang>.
vi.mock('@/features/new-version/notice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/new-version/notice')>()),
  useNewVersionNotice: vi.fn(),
  newVersionFound: vi.fn(),
  refreshNow: vi.fn(),
}));

// The error pages (docs/DECISIONS.md VPS-9).

const chunkError = () =>
  Object.assign(new Error('Failed to load chunk /_next/static/chunks/0ab.js from module 42'), {
    name: 'ChunkLoadError',
  });

const report = vi.fn();

beforeEach(() => {
  vi.mocked(useNewVersionNotice).mockReturnValue({ notice: 'none', cause: 'version' });
  vi.mocked(newVersionFound).mockClear();
  vi.mocked(refreshNow).mockClear();
  report.mockClear();
  window.reportError = report;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('an error page', () => {
  it('offers Try again and Refresh, and reports a browser error in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const retry = vi.fn();
    const error = new Error('Cannot read properties of undefined');
    render(<ErrorFallback error={error} retry={retry} lang="en" surface="page" />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Something went wrong' });
    expect(heading).toHaveFocus();
    expect(screen.getByText('Try again, or refresh the page.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refreshNow).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(error);
    expect(newVersionFound).not.toHaveBeenCalled();
  });

  it('leaves reporting to the dev overlay in development', () => {
    render(<ErrorFallback error={new Error('Boom')} retry={vi.fn()} lang="en" surface="page" />);
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(report).not.toHaveBeenCalled();
  });

  it('shows a server error’s code, which the server has reported already', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const error = Object.assign(new Error('An error occurred in the Server Components render.'), {
      digest: 'abc',
    });
    render(<ErrorFallback error={error} retry={vi.fn()} lang="en" surface="page" />);
    expect(screen.getByText('Error code abc')).toBeInTheDocument();
    expect(report).not.toHaveBeenCalled();
  });

  it('refreshes onto the new build when an older build’s action failed, unreported', () => {
    vi.stubEnv('NODE_ENV', 'production');
    render(
      <ErrorFallback
        error={new UnrecognizedActionError('Server Action "7f0a" was not found on the server.')}
        retry={vi.fn()}
        lang="en"
        surface="page"
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'A new version is ready. Refreshing…' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(newVersionFound).toHaveBeenCalledWith('boundary', 'version');
    expect(report).not.toHaveBeenCalled();
  });

  it('claims no new version for a script that didn’t load, and still reports it', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const error = chunkError();
    render(<ErrorFallback error={error} retry={vi.fn()} lang="en" surface="customer" />);
    expect(
      screen.getByRole('heading', { name: 'Part of this page didn’t load. Refreshing…' }),
    ).toBeInTheDocument();
    expect(newVersionFound).toHaveBeenCalledWith('boundary', 'chunk');
    expect(report).toHaveBeenCalledWith(error);
  });

  it('offers Refresh once a refresh can’t help by itself', () => {
    vi.mocked(useNewVersionNotice).mockReturnValue({ notice: 'stuck', cause: 'version' });
    const { unmount } = render(
      <ErrorFallback
        error={new UnrecognizedActionError('x')}
        retry={vi.fn()}
        lang="en"
        surface="page"
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'The new version didn’t load' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refreshNow).toHaveBeenCalledOnce();
    unmount();

    render(<ErrorFallback error={chunkError()} retry={vi.fn()} lang="en" surface="page" />);
    expect(
      screen.getByRole('heading', { name: 'Part of this page didn’t load' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Check the connection, then refresh the page.')).toBeInTheDocument();
  });

  it('speaks the page’s language', () => {
    render(
      <ErrorFallback error={new Error('Boom')} retry={vi.fn()} lang="hi" surface="customer" />,
    );
    expect(screen.getByRole('heading', { name: 'कुछ गड़बड़ हो गई' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'फिर से कोशिश करें' })).toBeInTheDocument();
  });

  it('is a card inside the worker panel, which keeps its own heading', () => {
    render(<ErrorFallback error={new Error('Boom')} retry={vi.fn()} lang="en" surface="panel" />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('main')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
  });
});

/** What app/error.tsx is for the root layout: an error boundary around the whole page. */
class RootBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    const { error } = this.state;
    return error ? <AppError error={error} reset={vi.fn()} retry={vi.fn()} /> : this.props.children;
  }
}

describe('the worker panel’s language', () => {
  const at = (path: string) => history.replaceState(null, '', path);
  let broken = false;
  function Layout() {
    if (broken) throw new Error('A render error in the layout, outside the panel’s own boundary');
    return <p>The panel</p>;
  }

  beforeEach(() => {
    broken = false;
    document.documentElement.lang = 'en';
    at('/staff');
    // React logs an error a boundary catches.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('keeps its language on the error page that replaces the panel (VPS-12)', () => {
    const panel = () => (
      <RootBoundary>
        <StaffLangProvider lang="hi">
          <Layout />
        </StaffLangProvider>
      </RootBoundary>
    );
    const { rerender } = render(panel());
    expect(document.documentElement.lang).toBe('hi');

    broken = true;
    rerender(panel());
    expect(
      screen.getByRole('heading', { level: 1, name: NEW_VERSION_STRINGS.hi.error.title }),
    ).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('hi');
  });

  // Back from the error page restores /admin softly: nothing unmounts at /staff after the error
  // page took the panel's place, so the admin panel puts English back itself (VPS-12).
  it('is put back to English by the admin panel after Back from that error page', () => {
    const panel = () => (
      <RootBoundary>
        <StaffLangProvider lang="hi">
          <Layout />
        </StaffLangProvider>
      </RootBoundary>
    );
    const { rerender } = render(panel());
    broken = true;
    rerender(panel());
    expect(
      screen.getByRole('heading', { level: 1, name: NEW_VERSION_STRINGS.hi.error.title }),
    ).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('hi');

    // Next.js resets the error boundary on the new path, and the admin layout mounts.
    at('/admin');
    rerender(<HtmlLang lang="en" />);
    expect(document.documentElement.lang).toBe('en');
  });

  it.each([
    'src/app/admin/(panel)/layout.tsx',
    'src/app/admin/(print)/layout.tsx',
    'src/app/super/(panel)/layout.tsx',
  ])('is mounted in English by %s', (layout) => {
    expect(readFileSync(layout, 'utf8')).toContain('<HtmlLang lang="en" />');
  });

  it.each([
    ['/admin', 'en'],
    ['/admin/live', 'en'],
    ['/login', 'en'],
    ['/staffroom', 'en'],
    ['/staff', 'hi'],
    ['/staff/kitchen', 'hi'],
  ])('unmounting at %s leaves <html lang> "%s"', (path, lang) => {
    const { unmount } = render(
      <StaffLangProvider lang="hi">
        <p>The panel</p>
      </StaffLangProvider>,
    );
    expect(document.documentElement.lang).toBe('hi');
    // Next.js has moved the URL before the panel's effects are cleaned up.
    at(path);
    unmount();
    expect(document.documentElement.lang).toBe(lang);
  });

  it('follows the login’s language when it changes inside the panel', () => {
    const { rerender } = render(
      <StaffLangProvider lang="hi">
        <p>The panel</p>
      </StaffLangProvider>,
    );
    rerender(
      <StaffLangProvider lang="en">
        <p>The panel</p>
      </StaffLangProvider>,
    );
    expect(document.documentElement.lang).toBe('en');
    rerender(
      <StaffLangProvider lang="hi">
        <p>The panel</p>
      </StaffLangProvider>,
    );
    expect(document.documentElement.lang).toBe('hi');
  });
});
