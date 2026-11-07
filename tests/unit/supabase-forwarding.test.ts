import { createServerClient } from '@supabase/ssr';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forwardingFetch } from '@/lib/supabase/forwarded-for';
import { updateSession } from '@/lib/supabase/proxy';
import { createClient as createServerSupabase } from '@/lib/supabase/server';

// Naming the visitor to Supabase Auth, in Sb-Forwarded-For and X-Real-IP (docs/DECISIONS.md VPS-4).

const settings = vi.hoisted(() => ({
  forward: false,
  internalUrl: undefined as string | undefined,
  headers: new Headers(),
}));
vi.mock('@/lib/env', () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: 'https://api.menumesh.in',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  }),
}));
vi.mock('@/lib/env.server', () => ({
  getServerEnv: () => ({
    SUPABASE_INTERNAL_URL: settings.internalUrl,
    SUPABASE_FORWARD_CLIENT_IP: settings.forward,
  }),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
  headers: async () => settings.headers,
}));
// The real client, watched for the options it is given.
vi.mock('@supabase/ssr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/ssr')>();
  return { ...actual, createServerClient: vi.fn(actual.createServerClient) };
});

const VISITOR = '203.0.113.7';
const AUTH = 'https://api.menumesh.in/auth/v1/token?grant_type=password';
const REST = 'https://api.menumesh.in/rest/v1/orders?select=id';

/** A fetch that records each call, with the headers it was given. */
function recorder() {
  const calls: { input: unknown; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response('{}');
  }) as unknown as typeof fetch;
  const sent = (call: number, name: string) => new Headers(calls[call]!.init?.headers).get(name);
  return { calls, fetchImpl, sent };
}

/** The module with its once-only warning not yet given, whatever ran before. */
async function freshForwarding() {
  vi.resetModules();
  return import('@/lib/supabase/forwarded-for');
}

beforeEach(() => {
  settings.forward = false;
  settings.internalUrl = undefined;
  settings.headers = new Headers();
  vi.mocked(createServerClient).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('forwardingFetch', () => {
  it('names the visitor to Supabase Auth in both headers, keeping the others', async () => {
    const { calls, fetchImpl, sent } = recorder();
    const headers = { apikey: 'k', 'Content-Type': 'application/json' };
    await forwardingFetch(
      'https://api.menumesh.in',
      VISITOR,
      fetchImpl,
    )(AUTH, {
      method: 'POST',
      headers,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(AUTH);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(sent(0, 'sb-forwarded-for')).toBe(VISITOR);
    expect(sent(0, 'x-real-ip')).toBe(VISITOR);
    expect(sent(0, 'apikey')).toBe('k');
    expect(sent(0, 'content-type')).toBe('application/json');
    // The caller's own headers are left as they were.
    expect(headers).toEqual({ apikey: 'k', 'Content-Type': 'application/json' });
  });

  it('adds nothing to the calls of any other service', async () => {
    const { calls, fetchImpl } = recorder();
    const forwarding = forwardingFetch('https://api.menumesh.in', VISITOR, fetchImpl);
    const init = { method: 'POST', headers: { apikey: 'k' } };
    for (const url of [
      REST,
      'https://api.menumesh.in/storage/v1/object/sign/b/p',
      'https://api.menumesh.in/functions/v1/f',
      'https://api.menumesh.in/auth/v10/token',
      'https://other.example/auth/v1/token',
    ]) {
      await forwarding(url, init);
    }
    expect(calls).toHaveLength(5);
    for (const call of calls) expect(call.init).toBe(init);
  });

  it('finds Auth at the project address however it is written', async () => {
    const { fetchImpl, sent } = recorder();
    await forwardingFetch('https://api.menumesh.in/', VISITOR, fetchImpl)(AUTH);
    await forwardingFetch(
      'http://api-gw:8000',
      VISITOR,
      fetchImpl,
    )(new URL('http://api-gw:8000/auth/v1/user'));
    await forwardingFetch(
      'https://x.supabase.co/gateway/',
      VISITOR,
      fetchImpl,
    )('https://x.supabase.co/gateway/auth/v1/user');
    for (const call of [0, 1, 2]) expect(sent(call, 'sb-forwarded-for')).toBe(VISITOR);
  });

  it('keeps the headers a Request carries, unless the call gives its own', async () => {
    const { fetchImpl, sent } = recorder();
    const forwarding = forwardingFetch('https://api.menumesh.in', VISITOR, fetchImpl);
    const request = () =>
      new Request(AUTH, { method: 'POST', headers: { apikey: 'from-request' } });

    await forwarding(request());
    expect(sent(0, 'apikey')).toBe('from-request');
    expect(sent(0, 'sb-forwarded-for')).toBe(VISITOR);

    // As fetch does: headers in init replace those of the Request.
    await forwarding(request(), { headers: { apikey: 'from-init' } });
    expect(sent(1, 'apikey')).toBe('from-init');
    expect(sent(1, 'x-real-ip')).toBe(VISITOR);
  });

  it('goes through supabase-js: the sign-in carries it, a table read does not', async () => {
    const seen: { url: string; forwarded: string | null; realIp: string | null }[] = [];
    const fake = (async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        forwarded: headers.get('sb-forwarded-for'),
        realIp: headers.get('x-real-ip'),
      });
      return String(input).includes('/auth/v1/')
        ? Response.json(
            { error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
            { status: 400 },
          )
        : Response.json([]);
    }) as unknown as typeof fetch;

    const supabase = createServerClient('https://api.menumesh.in', 'sb_publishable_test', {
      cookies: { getAll: () => [], setAll: () => undefined },
      global: { fetch: forwardingFetch('https://api.menumesh.in', '2001:db8::1', fake) },
    });
    await supabase.auth.signInWithPassword({ email: 'a@b.in', password: 'x' });
    await supabase.from('orders').select('id');

    expect(seen).toEqual([
      { url: AUTH, forwarded: '2001:db8::1', realIp: '2001:db8::1' },
      { url: expect.stringContaining('/rest/v1/orders'), forwarded: null, realIp: null },
    ]);
  });
});

describe('forwardedVisitorIp', () => {
  it('is off unless SUPABASE_FORWARD_CLIENT_IP is on, and then reads no header', async () => {
    const { forwardedVisitorIp } = await freshForwarding();
    const getHeaders = vi.fn(() => new Headers({ 'x-real-ip': VISITOR }));
    expect(await forwardedVisitorIp(getHeaders)).toBeNull();
    expect(getHeaders).not.toHaveBeenCalled();
  });

  it('takes X-Real-IP, then the first X-Forwarded-For, and only a real address', async () => {
    const { forwardedVisitorIp } = await freshForwarding();
    settings.forward = true;
    const ip = (headers: Record<string, string>) => forwardedVisitorIp(() => new Headers(headers));

    expect(await ip({ 'x-real-ip': VISITOR, 'x-forwarded-for': '198.51.100.2' })).toBe(VISITOR);
    expect(await ip({ 'x-forwarded-for': '198.51.100.2, 10.0.0.1' })).toBe('198.51.100.2');
    expect(await ip({ 'x-real-ip': '2001:db8::1' })).toBe('2001:db8::1');
    for (const value of ['unknown', '203.0.113.7:443', '1.2.3', '']) {
      expect(await ip({ 'x-real-ip': value })).toBeNull();
    }
    expect(await ip({})).toBeNull();
  });

  it('says once, and never with the value, that it has no address to send', async () => {
    const { forwardedVisitorIp } = await freshForwarding();
    settings.forward = true;
    await forwardedVisitorIp(() => new Headers({ 'x-real-ip': 'sent-by-the-visitor' }));
    await forwardedVisitorIp(() => new Headers());

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'sent-by-the-visitor',
    );
  });
});

describe('the server clients', () => {
  const clients = async () => {
    await createServerSupabase();
    await updateSession(
      new NextRequest('http://localhost:3000/login', { headers: settings.headers }),
    );
    return vi.mocked(createServerClient).mock.calls.map(([, , options]) => options);
  };

  it('name the visitor on Auth calls to the address they use, and on no other', async () => {
    settings.forward = true;
    settings.internalUrl = 'http://api-gw:8000';
    settings.headers = new Headers({ 'x-real-ip': VISITOR });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}));

    const [server, proxy] = await clients();
    for (const options of [server, proxy]) {
      await options!.global!.fetch!('http://api-gw:8000/auth/v1/token', { method: 'POST' });
      await options!.global!.fetch!('http://api-gw:8000/rest/v1/orders');
      await options!.global!.fetch!(AUTH, { method: 'POST' });
    }

    expect(
      fetchSpy.mock.calls.map(([url, init]) => [
        String(url),
        new Headers(init?.headers).get('sb-forwarded-for'),
        new Headers(init?.headers).get('x-real-ip'),
      ]),
    ).toEqual(
      [0, 1].flatMap(() => [
        ['http://api-gw:8000/auth/v1/token', VISITOR, VISITOR],
        ['http://api-gw:8000/rest/v1/orders', null, null],
        [AUTH, null, null],
      ]),
    );
  });

  it('name nobody when the setting is off', async () => {
    settings.headers = new Headers({ 'x-real-ip': VISITOR });
    for (const options of await clients()) expect(options?.global).toBeUndefined();
  });

  it('name nobody when the request has no address', async () => {
    settings.forward = true;
    settings.headers = new Headers({ 'x-real-ip': 'unknown' });
    for (const options of await clients()) expect(options?.global).toBeUndefined();
  });
});
