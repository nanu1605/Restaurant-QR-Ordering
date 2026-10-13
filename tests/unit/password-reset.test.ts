import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { passwordResetEmail } from '@/app/login/forgot/reset';
import { resetPasswordSchema, resetRequestSchema } from '@/app/login/forgot/schemas';
import { hashCode, newCode } from '@/lib/one-time-code';

// "Forgot password" (docs/DECISIONS.md P11-6 to P11-9).

const SECRET = 'x'.repeat(32);
vi.mock('@/lib/env.server', () => ({ getServerEnv: () => ({ CUSTOMER_COOKIE_SECRET: SECRET }) }));

const issues = (result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) => result.error?.issues.map((issue) => [issue.path[0], issue.message]) ?? [];

describe('forgot password', () => {
  it('takes the email as the login does', () => {
    expect(resetRequestSchema.parse({ email: ' Owner@Example.COM ' }).email).toBe(
      'owner@example.com',
    );
    expect(issues(resetRequestSchema.safeParse({ email: 'nope' }))).toEqual([
      ['email', 'Enter a valid email address.'],
    ]);
    // Emails stop at 254 characters, as the table does: this one is 255.
    expect(issues(resetRequestSchema.safeParse({ email: `${'a'.repeat(250)}@x.in` }))).toEqual([
      ['email', 'Enter a valid email address.'],
    ]);
  });

  it('checks the code and the new password, typed twice', () => {
    expect(
      resetPasswordSchema.parse({ code: '123 456', password: 'new-pass-1', confirm: 'new-pass-1' }),
    ).toEqual({ code: '123456', password: 'new-pass-1', confirm: 'new-pass-1' });
    expect(
      issues(resetPasswordSchema.safeParse({ code: '12345', password: 'short', confirm: 'short' })),
    ).toEqual([
      ['code', 'Enter the 6-digit code from the email.'],
      ['password', 'Use at least 8 characters.'],
    ]);
    expect(
      issues(
        resetPasswordSchema.safeParse({
          code: '123456',
          password: 'new-pass-1',
          confirm: 'new-pass-2',
        }),
      ),
    ).toEqual([['confirm', 'The passwords don’t match. Type the new password again.']]);
    // Supabase Auth reads 72 bytes: 25 Devanagari letters are 75.
    const hindi = 'क'.repeat(25);
    expect(
      issues(resetPasswordSchema.safeParse({ code: '123456', password: hindi, confirm: hindi })),
    ).toEqual([['password', 'Use a shorter password.']]);
  });

  it('emails the code in the subject and in bold', () => {
    const email = passwordResetEmail('042917');
    expect(email.subject).toBe('042917 is your MenuMesh password reset code');
    expect(email.text).toContain('It works for 15 minutes.');
    expect(email.text).toContain('Your password stays the same.');
    expect(email.html).toContain(
      '<strong style="font-size:24px;letter-spacing:4px">042917</strong>',
    );
    expect(email.html).toContain('didn’t ask for this');
  });

  it('hashes reset codes apart from signup codes, and signup codes as before', () => {
    expect(newCode()).toMatch(/^\d{6}$/);
    expect(hashCode('signup', '123456')).toBe(
      createHmac('sha256', SECRET).update('signup-code:123456').digest('hex'),
    );
    expect(hashCode('password-reset', '123456')).not.toBe(hashCode('signup', '123456'));
  });
});
