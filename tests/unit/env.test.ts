import { describe, expect, it } from 'vitest';

import { parsePublicEnv } from '@/lib/env';
import { parseServerEnv } from '@/lib/env.server';

const validPublic = {
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
};

const validServer = {
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  CUSTOMER_COOKIE_SECRET: 'x'.repeat(32),
};

describe('parsePublicEnv', () => {
  it('accepts the required variables and treats empty optionals as unset', () => {
    const env = parsePublicEnv({ ...validPublic, NEXT_PUBLIC_POSTHOG_HOST: '' });
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000');
    expect(env.NEXT_PUBLIC_POSTHOG_HOST).toBeUndefined();
  });

  it('names every missing or invalid variable', () => {
    expect(() =>
      parsePublicEnv({ NEXT_PUBLIC_APP_URL: 'not a url', NEXT_PUBLIC_SUPABASE_URL: undefined }),
    ).toThrow(
      /NEXT_PUBLIC_APP_URL[\s\S]*NEXT_PUBLIC_SUPABASE_URL[\s\S]*NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/,
    );
  });
});

describe('parseServerEnv', () => {
  it('applies defaults for optional settings', () => {
    const env = parseServerEnv({ ...validServer, PLATFORM_TRIAL_DAYS: '' });
    expect(env.PLATFORM_TRIAL_DAYS).toBe(14);
    expect(env.PLATFORM_GRACE_DAYS).toBe(7);
    expect(env.MENU_IMPORT_MODEL).toBe('google/gemini-3.8-flash');
    expect(env.MENU_IMPORT_BASE_URL).toBe('https://api.commandcode.ai/provider/v1');
    expect(env.MENU_IMPORT_FALLBACK_BASE_URL).toBe('https://openrouter.ai/api/v1');
    expect(env.MENU_IMPORT_API_KEY).toBeUndefined();
  });

  it('coerces numeric settings and rejects a short cookie secret', () => {
    expect(parseServerEnv({ ...validServer, PLATFORM_GRACE_DAYS: '10' }).PLATFORM_GRACE_DAYS).toBe(
      10,
    );
    expect(() => parseServerEnv({ ...validServer, CUSTOMER_COOKIE_SECRET: 'short' })).toThrow(
      /CUSTOMER_COOKIE_SECRET/,
    );
  });

  it('requires the secret key and the cookie secret', () => {
    expect(() => parseServerEnv({})).toThrow(/SUPABASE_SECRET_KEY[\s\S]*CUSTOMER_COOKIE_SECRET/);
  });
});
