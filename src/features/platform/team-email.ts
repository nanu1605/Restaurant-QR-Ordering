import { APP_NAME } from '@/lib/config';
import { escapeHtml } from '@/lib/email/resend';

import { INVITE_DAYS, TEAM_ROLE_LABELS, type TeamRole } from './team';

/** The invite to the team (docs/DECISIONS.md SA-70+): the link and what comes after it. */
export function teamInviteEmail({
  name,
  invitedBy,
  role,
  link,
}: {
  name: string;
  invitedBy: string;
  role: TeamRole;
  link: string;
}) {
  const lines = [
    `Hi ${name},`,
    `${invitedBy} has added you to the ${APP_NAME} team as ${TEAM_ROLE_LABELS[role]}.`,
    `Open this link to choose your password: ${link}`,
    `Then set up an authenticator app on your phone; the team panel asks for its code each time you sign in. The link works for ${INVITE_DAYS} days.`,
    'If you weren’t expecting this, ignore this email.',
  ];
  return {
    subject: `You’re invited to the ${APP_NAME} team`,
    text: lines.join('\n\n'),
    html: lines
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('\n')
      .replace(escapeHtml(link), `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`),
  };
}
