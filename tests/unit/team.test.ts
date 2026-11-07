import { describe, expect, it } from 'vitest';

import { navFor } from '@/features/platform/components/super-nav';
import {
  inviteSchema,
  joinSchema,
  memberPatchSchema,
  memberStatus,
  type TeamListRow,
} from '@/features/platform/team';
import { teamInviteEmail } from '@/features/platform/team-email';

const SALES = ['restaurants.view', 'restaurants.manage', 'growth.manage', 'insights.view'];

describe('the navigation by role', () => {
  it('shows a group only with a page the role opens', () => {
    expect(
      navFor(SALES).map((group) => [group.title, group.items.map((item) => item.label)]),
    ).toEqual([
      [null, ['Home']],
      ['Money', ['Subscriptions']],
      ['Restaurants', ['Restaurants', 'Standees']],
      ['Growth', ['Leads', 'Funnel']],
      ['Insights', ['Usage']],
    ]);
  });

  it('gives an Admin the team page under Settings', () => {
    const all = [...SALES, 'money.view', 'settings.manage', 'team.manage', 'audit.view'];
    expect(
      navFor(all)
        .find((group) => group.title === 'Settings')
        ?.items.map((i) => i.label),
    ).toEqual(['Platform settings', 'Team', 'Plans', 'Offers', 'Announcements', 'Audit log']);
  });
});

describe('members', () => {
  const member = (patch: Partial<TeamListRow>): TeamListRow => ({
    user_id: 'u',
    email: 'a@b.test',
    display_name: null,
    role: 'sales',
    invited_by: null,
    invited_at: null,
    joined_at: '2026-10-01T00:00:00Z',
    disabled_at: null,
    invite_expires_at: null,
    second_factor: true,
    last_sign_in_at: null,
    digest: false,
    is_you: false,
    ...patch,
  });

  it('are active, invited or off', () => {
    expect(memberStatus(member({}))).toBe('active');
    expect(memberStatus(member({ joined_at: null }))).toBe('invited');
    expect(memberStatus(member({ disabled_at: '2026-10-02T00:00:00Z' }))).toBe('off');
  });

  it('are invited with an email, a name and one of the four roles', () => {
    expect(
      inviteSchema.parse({ email: ' Tara@Example.TEST ', displayName: ' Tara ', role: 'sales' }),
    ).toEqual({ email: 'tara@example.test', displayName: 'Tara', role: 'sales' });
    expect(inviteSchema.safeParse({ email: 'x', displayName: 'T', role: 'sales' }).success).toBe(
      false,
    );
    expect(
      inviteSchema.safeParse({ email: 'a@b.test', displayName: 'T', role: 'owner' }).success,
    ).toBe(false);
    expect(memberPatchSchema.safeParse({}).success).toBe(false);
  });

  it('join with a password typed twice the same', () => {
    const token = 'x'.repeat(43);
    expect(
      joinSchema.safeParse({ token, password: 'long-enough', confirm: 'long-enough' }).success,
    ).toBe(true);
    const mismatch = joinSchema.safeParse({ token, password: 'long-enough', confirm: 'other-one' });
    expect(mismatch.error?.issues[0]?.path).toEqual(['confirm']);
    expect(joinSchema.safeParse({ token, password: 'short', confirm: 'short' }).success).toBe(
      false,
    );
  });
});

describe('the invite email', () => {
  it('names the role and links the page, escaped', () => {
    const email = teamInviteEmail({
      name: 'Tara <T>',
      invitedBy: 'Asha',
      role: 'finance',
      link: 'https://menumesh.in/login/join?token=abc&x=1',
    });
    expect(email.subject).toBe('You’re invited to the MenuMesh team');
    expect(email.text).toContain('Asha has added you to the MenuMesh team as Finance.');
    expect(email.text).toContain('https://menumesh.in/login/join?token=abc&x=1');
    expect(email.html).toContain('Hi Tara &lt;T&gt;,');
    expect(email.html).toContain(
      '<a href="https://menumesh.in/login/join?token=abc&amp;x=1">https://menumesh.in/login/join?token=abc&amp;x=1</a>',
    );
  });
});
