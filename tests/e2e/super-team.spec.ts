import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { adminClient } from './helpers';
import {
  createPlatformAdmin,
  logInAsPlatformAdmin,
  passSecondFactor,
  type PlatformAdmin,
} from './platform-fixtures';

// Team and roles (docs/SUPER_ADMIN_PLAN.md 13g; docs/DECISIONS.md SA-70+).

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function inbox(request: APIRequestContext, to: string) {
  const response = await request.get(`http://127.0.0.1:3190/resend/inbox?to=${to}`);
  return ((await response.json()) as { emails: { subject: string; text: string }[] }).emails;
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Platform sections' }).first();

async function openTeam(page: Page) {
  await nav(page).getByRole('link', { name: 'Team' }).click();
  await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
}

function memberRow(page: Page, email: string) {
  return page.getByRole('row').filter({ hasText: email });
}

test('an invite by email: the link, a password and a second factor, then only Sales pages', async ({
  page,
  browser,
  request,
}) => {
  test.slow();
  const admin = await createPlatformAdmin('e2e-team');
  const email = `e2e-team-new-${unique()}@platform.test`;
  await logInAsPlatformAdmin(page, admin);
  await openTeam(page);

  await page.getByRole('button', { name: 'Invite a team member' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite a team member' });
  await invite.getByLabel('Email').fill(email);
  await invite.getByLabel('Name').fill('Tara Sales');
  await invite.getByLabel('Role').selectOption('sales');
  await expect(invite).toContainText('leads and the funnel');
  await invite.getByRole('button', { name: 'Invite' }).click();

  const ready = page.getByRole('dialog', { name: 'Invite ready' });
  await expect(ready).toContainText(`We’re emailing the link to ${email}`);
  const link = await ready.getByLabel('Invite link').inputValue();
  expect(link).toMatch(/\/login\/join\?token=[\w-]{40,}$/);
  await ready.getByRole('button', { name: 'Done' }).click();
  await expect(memberRow(page, email)).toContainText('Invited, link works until');
  await expect(memberRow(page, email)).toContainText('Sales');

  // The email carries the same link.
  await expect.poll(async () => (await inbox(request, email)).length).toBe(1);
  const [sent] = await inbox(request, email);
  expect(sent!.subject).toBe('You’re invited to the MenuMesh team');
  expect(sent!.text).toContain(link);

  // The new member, on their own device.
  const context = await browser.newContext();
  const member = await context.newPage();
  try {
    await member.goto(new URL(link).pathname + new URL(link).search);
    await expect(member.getByRole('heading', { name: 'Join the MenuMesh team' })).toBeVisible();
    await expect(member.getByRole('main')).toContainText('you’re joining as Sales');
    await member.getByLabel('Password', { exact: true }).fill('team-pass-1234');
    await member.getByLabel('Password again').fill('team-pass-1234');
    await member.getByRole('button', { name: 'Join the team' }).click();
    const joined: PlatformAdmin = { email, userId: '' };
    await passSecondFactor(member, joined);

    // Sales: leads, funnel, usage and restaurants; no money, team or audit log.
    const sections = nav(member);
    for (const name of ['Restaurants', 'Leads', 'Funnel', 'Usage'])
      await expect(sections.getByRole('link', { name, exact: true })).toBeVisible();
    for (const name of ['Payments', 'Dues', 'Revenue', 'Team', 'Audit log', 'Webhooks'])
      await expect(sections.getByRole('link', { name, exact: true })).toHaveCount(0);
    await member.goto('/super/money/payments');
    await expect(member).toHaveURL(/\/super\?denied=1$/);
    await expect(
      member.getByRole('status').filter({ hasText: 'Your role doesn’t open that page' }),
    ).toBeVisible();

    // The link is spent.
    await member.goto(new URL(link).pathname + new URL(link).search);
    await expect(member.getByRole('main')).toContainText('expired or was already used');
  } finally {
    await context.close();
  }

  await page.reload();
  await expect(memberRow(page, email)).toContainText('Active');
  await expect(memberRow(page, email)).toContainText('Set up');
});

test('a new role, turned off and back on', async ({ page, browser }) => {
  // Two members, each signing in, one of them twice.
  test.slow();
  const admin = await createPlatformAdmin('e2e-team-admin');
  const support = await createPlatformAdmin('e2e-team-support', 'support');
  await logInAsPlatformAdmin(page, admin);
  await openTeam(page);
  await expect(memberRow(page, admin.email)).toContainText('(you)');

  // Support becomes Finance.
  await memberRow(page, support.email)
    .getByRole('button', { name: /^Actions for / })
    .click();
  await page.getByRole('menuitem', { name: 'Change role or name' }).click();
  const edit = page.getByRole('dialog', { name: /^Change / });
  await edit.getByLabel('Name').fill('Sam Finance');
  await edit.getByLabel('Role').selectOption('finance');
  await expect(edit.getByLabel(/Daily digest email/)).toBeChecked();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(memberRow(page, support.email)).toContainText('Finance');
  await expect(memberRow(page, support.email)).toContainText('Sam Finance');
  const { data: audit } = await adminClient()
    .from('audit_logs')
    .select('before, after')
    .eq('action', 'platform_admin.updated')
    .eq('entity_id', support.userId)
    .single()
    .throwOnError();
  expect(audit).toEqual({
    before: { role: 'support', display_name: null },
    after: { role: 'finance', display_name: 'Sam Finance' },
  });

  // Signed in elsewhere as Finance: money, no support inbox; the header names them.
  const context = await browser.newContext();
  const other = await context.newPage();
  try {
    await logInAsPlatformAdmin(other, support);
    await expect(nav(other).getByRole('link', { name: 'Payments' })).toBeVisible();
    await expect(nav(other).getByRole('link', { name: 'Support inbox' })).toHaveCount(0);
    await expect(other.getByRole('banner')).toContainText('Sam Finance');

    // Turned off: their next page sends them away; nobody turns themselves off.
    await memberRow(page, admin.email)
      .getByRole('button', { name: /^Actions for / })
      .click();
    await expect(page.getByRole('menuitem', { name: 'Turn off' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await memberRow(page, support.email)
      .getByRole('button', { name: /^Actions for / })
      .click();
    await page.getByRole('menuitem', { name: 'Turn off' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Turn off' }).click();
    await expect(memberRow(page, support.email)).toContainText('Off since');
    await other.goto('/super/money/payments');
    await expect(other).toHaveURL(/\/login/);

    // Back on: they sign in again.
    await memberRow(page, support.email)
      .getByRole('button', { name: /^Actions for / })
      .click();
    await page.getByRole('menuitem', { name: 'Turn back on' }).click();
    await expect(memberRow(page, support.email)).toContainText('Active');
    await context.clearCookies();
    await logInAsPlatformAdmin(other, support);
    await expect(nav(other).getByRole('link', { name: 'Payments' })).toBeVisible();
  } finally {
    await context.close();
  }

  // What they did: the audit log for one member.
  await memberRow(page, support.email)
    .getByRole('button', { name: /^Actions for / })
    .click();
  await page.getByRole('menuitem', { name: 'What they did' }).click();
  await expect(page).toHaveURL(new RegExp(`/super/audit\\?member=${support.userId}`));
  await expect(page.getByRole('status').filter({ hasText: 'Showing what' })).toBeVisible();
});
