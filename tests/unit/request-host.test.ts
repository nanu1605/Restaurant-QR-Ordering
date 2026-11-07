import { describe, expect, it } from 'vitest';

import { requestHostname } from '@/lib/request-host';

const host = (headers: Record<string, string>) => requestHostname(new Headers(headers));

describe('requestHostname (docs/DECISIONS.md W-12, VPS-2)', () => {
  it('takes the first X-Forwarded-Host, as a proxy passes it on', () => {
    expect(host({ 'x-forwarded-host': 'MenuMesh.in:443, web:3000', host: 'web:3000' })).toBe(
      'menumesh.in',
    );
  });

  it('falls back to Host without its port, keeping the brackets of an IPv6 address', () => {
    expect(host({ host: 'localhost:3100' })).toBe('localhost');
    expect(host({ 'x-forwarded-host': '', host: 'staging.menumesh.in' })).toBe(
      'staging.menumesh.in',
    );
    expect(host({ host: '[::1]:3000' })).toBe('[::1]');
  });

  it('is null when neither header is there', () => {
    expect(host({})).toBeNull();
  });
});
