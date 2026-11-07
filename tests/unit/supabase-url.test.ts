import { createBrowserClient, createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient as createBrowserSupabase } from '@/lib/supabase/browser';
import { supabaseAuthCookieName } from '@/lib/supabase/cookie-name';
import { updateSession } from '@/lib/supabase/proxy';
import { createClient as createServerSupabase } from '@/lib/supabase/server';
import { supabaseServerUrl, toPublicSupabaseUrl } from '@/lib/supabase/url';

// The server's own address for Supabase, and the session cookie it shares with the browser
// (docs/DECISIONS.md VPS-20).

const settings = vi.hoisted(() => ({
  publicUrl: 'https://api.menumesh.in',
  internalUrl: undefined as string | undefined,
}));
vi.mock('@/lib/env', () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: settings.publicUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  }),
}));
vi.mock('@/lib/env.server', () => ({
  getServerEnv: () => ({
    SUPABASE_INTERNAL_URL: settings.internalUrl,
    SUPABASE_SECRET_KEY: 'sb_secret_test',
  }),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
  headers: async () => new Headers(),
}));
// The real clients, watched for the address and the options they are given.
vi.mock('@supabase/ssr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/ssr')>();
  return {
    ...actual,
    createServerClient: vi.fn(actual.createServerClient),
    createBrowserClient: vi.fn(actual.createBrowserClient),
  };
});

/** What supabase-js names the session's storage when it is given an address and nothing else. */
const defaultStorageKey = (url: string) =>
  (
    createSupabaseClient(url, 'sb_publishable_test', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }).auth as unknown as { storageKey: string }
  ).storageKey;

function use(publicUrl: string, internalUrl?: string) {
  settings.publicUrl = publicUrl;
  settings.internalUrl = internalUrl;
}

beforeEach(() => {
  vi.mocked(createServerClient).mockClear();
  vi.mocked(createBrowserClient).mockClear();
});

describe('the session cookie name', () => {
  it.each([
    ['https://x.supabase.co', 'sb-x-auth-token'],
    ['http://127.0.0.1:54321', 'sb-127-auth-token'],
    ['https://api.menumesh.in', 'sb-api-auth-token'],
  ])('is the name supabase-js gives %s', (url, name) => {
    expect(supabaseAuthCookieName(url)).toBe(name);
    expect(defaultStorageKey(url)).toBe(name);
  });

  it('is one name for the browser and both server clients, with an internal address', async () => {
    use('https://api.menumesh.in', 'http://api-gw:8000');
    await createServerSupabase();
    await updateSession(new NextRequest('http://localhost:3000/login'));
    createBrowserSupabase();

    const server = vi.mocked(createServerClient).mock.calls.map(([, , options]) => options);
    const browser = vi.mocked(createBrowserClient).mock.calls.map(([, , options]) => options);
    expect([...server, ...browser].map((options) => options?.cookieOptions?.name)).toEqual([
      'sb-api-auth-token',
      'sb-api-auth-token',
      'sb-api-auth-token',
    ]);
  });
});

describe('the address the server calls', () => {
  it('is the internal one when it is set, for the server, proxy and admin clients', async () => {
    use('https://api.menumesh.in', 'http://api-gw:8000');
    expect(supabaseServerUrl()).toBe('http://api-gw:8000');

    await createServerSupabase();
    await updateSession(new NextRequest('http://localhost:3000/login'));
    expect(vi.mocked(createServerClient).mock.calls.map(([url]) => url)).toEqual([
      'http://api-gw:8000',
      'http://api-gw:8000',
    ]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json('ok'));
    await createAdminClient().rpc('health_check');
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://api-gw:8000/rest/v1/rpc/health_check');
  });

  it('is the public one otherwise, so Vercel and hosted staging are as before', async () => {
    use('https://x.supabase.co');
    expect(supabaseServerUrl()).toBe('https://x.supabase.co');

    await createServerSupabase();
    await updateSession(new NextRequest('http://localhost:3000/login'));
    expect(vi.mocked(createServerClient).mock.calls.map(([url]) => url)).toEqual([
      'https://x.supabase.co',
      'https://x.supabase.co',
    ]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json('ok'));
    await createAdminClient().rpc('health_check');
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      'https://x.supabase.co/rest/v1/rpc/health_check',
    );
  });

  it('is never the browser client’s', () => {
    use('https://api.menumesh.in', 'http://api-gw:8000');
    createBrowserSupabase();
    expect(vi.mocked(createBrowserClient).mock.calls[0]![0]).toBe('https://api.menumesh.in');
  });
});

describe('signed links for the browser', () => {
  const signed = (path: string) => `http://api-gw:8000/storage/v1/object/sign/${path}`;

  it('swap the internal address for the public one and keep the rest', () => {
    use('https://api.menumesh.in', 'http://api-gw:8000');
    expect(toPublicSupabaseUrl(signed('restaurant-exports/r1/e1.zip?token=t&download=a.zip'))).toBe(
      'https://api.menumesh.in/storage/v1/object/sign/restaurant-exports/r1/e1.zip?token=t&download=a.zip',
    );
  });

  it('match the address however it is written', () => {
    use('https://x.supabase.co/', 'http://api-gw:80/gateway/');
    expect(toPublicSupabaseUrl('http://api-gw/gateway/storage/v1/object/sign/b/p?token=t')).toBe(
      'https://x.supabase.co/storage/v1/object/sign/b/p?token=t',
    );
  });

  it('are as storage-js wrote them without an internal address', () => {
    use('https://x.supabase.co');
    const link = 'https://x.supabase.co/storage/v1/object/sign/b/p?token=t';
    expect(toPublicSupabaseUrl(link)).toBe(link);
  });

  it('leave a link on another address alone', () => {
    use('https://api.menumesh.in', 'http://api-gw:8000');
    for (const link of [
      'https://api.menumesh.in/storage/v1/object/sign/b/p?token=t',
      'http://api-gw:8000.example.com/storage/v1/object/sign/b/p?token=t',
      'http://api-gw:8001/storage/v1/object/sign/b/p?token=t',
    ]) {
      expect(toPublicSupabaseUrl(link)).toBe(link);
    }
  });

  it('turn what the admin client’s storage returns into a public link', async () => {
    use('https://api.menumesh.in', 'http://api-gw:8000');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ signedURL: '/object/sign/restaurant-exports/r1/e1.zip?token=t' }),
    );
    const { data } = await createAdminClient()
      .storage.from('restaurant-exports')
      .createSignedUrl('r1/e1.zip', 60);
    expect(data?.signedUrl).toBe(signed('restaurant-exports/r1/e1.zip?token=t'));
    expect(toPublicSupabaseUrl(data!.signedUrl)).toBe(
      'https://api.menumesh.in/storage/v1/object/sign/restaurant-exports/r1/e1.zip?token=t',
    );
  });
});
