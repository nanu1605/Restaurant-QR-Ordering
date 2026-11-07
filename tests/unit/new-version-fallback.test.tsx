// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { UnrecognizedActionError } from 'next/dist/client/components/unrecognized-action-error';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorFallback } from '@/features/new-version/components/error-fallback';
import { newVersionFound, refreshNow, useNewVersionNotice } from '@/features/new-version/notice';

vi.mock('@/features/new-version/notice', () => ({
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
