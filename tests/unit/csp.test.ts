import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy } from '@/lib/csp';

const directives = (policy: string) =>
  Object.fromEntries(policy.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));

describe('content security policy (docs/DECISIONS.md P9-9)', () => {
  it('allows scripts by nonce only, and Supabase over https and wss', () => {
    const policy = directives(
      contentSecurityPolicy({
        nonce: 'abc',
        appUrl: 'https://menumesh.in',
        supabaseUrl: 'https://x.supabase.co',
        dev: false,
      }),
    );
    expect(policy['script-src']).toEqual([
      "'self'",
      "'nonce-abc'",
      "'strict-dynamic'",
      'https://*.razorpay.com',
    ]);
    expect(policy['connect-src']).toEqual([
      "'self'",
      'https://x.supabase.co',
      'wss://x.supabase.co',
      'https://*.razorpay.com',
    ]);
    expect(policy['frame-ancestors']).toEqual(["'none'"]);
    expect(policy['object-src']).toEqual(["'none'"]);
    expect(policy['upgrade-insecure-requests']).toEqual([]);
  });

  it('keeps local http working and adds eval only in development', () => {
    const local = directives(
      contentSecurityPolicy({
        nonce: 'n',
        appUrl: 'http://localhost:3000',
        supabaseUrl: 'http://127.0.0.1:54321',
        dev: true,
      }),
    );
    expect(local['connect-src']).toContain('ws://127.0.0.1:54321');
    expect(local['img-src']).toContain('http://127.0.0.1:54321');
    expect(local['script-src']).toContain("'unsafe-eval'");
    expect(local).not.toHaveProperty('upgrade-insecure-requests');
  });

  it('upgrades requests only when the app itself is on https', () => {
    // A phone on the LAN testing an http build against a hosted Supabase.
    const lan = directives(
      contentSecurityPolicy({
        nonce: 'n',
        appUrl: 'http://192.168.1.20:3000',
        supabaseUrl: 'https://x.supabase.co',
        dev: false,
      }),
    );
    expect(lan['connect-src']).toContain('wss://x.supabase.co');
    expect(lan).not.toHaveProperty('upgrade-insecure-requests');
  });
});
