import { formatDateTime } from '@/features/platform/platform';

import { deploymentVersions, sentryIssues } from '../checks';
import { Outcome } from './parts';
import { Section } from './system-sections';

const linkClass = 'font-medium text-brand underline-offset-4 hover:underline';
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : 'not known');

/** Sentry's unresolved issues of the last 24 hours (docs/DECISIONS.md SA-89). */
export async function SentrySection() {
  const issues = await sentryIssues();
  return (
    <Section
      id="errors-heading"
      title="Errors"
      description="Unresolved Sentry issues seen in the last 24 hours, in this environment."
    >
      {issues.state === 'off' ? (
        <p className="text-sm text-ink-muted">
          Not set up: add a read-only Sentry token as SENTRY_READ_TOKEN, with SENTRY_ORG and
          SENTRY_PROJECT.
        </p>
      ) : issues.state === 'refused' ? (
        <Outcome tone="bad">
          Sentry refused the request ({issues.status}): check SENTRY_READ_TOKEN, SENTRY_ORG and
          SENTRY_PROJECT.
        </Outcome>
      ) : issues.state === 'error' ? (
        <Outcome tone="bad">Sentry couldn’t be reached. Try again in a few minutes.</Outcome>
      ) : issues.count === 0 ? (
        <Outcome tone="ok">No issues</Outcome>
      ) : (
        <>
          <Outcome tone="bad">
            {issues.more
              ? '100 or more issues'
              : issues.count === 1
                ? '1 issue'
                : `${issues.count} issues`}
          </Outcome>
          <ol className="flex flex-col gap-2 text-sm">
            {issues.top.map((issue) => (
              <li key={issue.id} className="flex flex-col">
                <a href={issue.permalink} target="_blank" rel="noreferrer" className={linkClass}>
                  {issue.title}
                </a>
                <span className="text-ink-muted">
                  {issue.shortId}, {issue.count.toLocaleString('en-IN')}{' '}
                  {issue.count === 1 ? 'event' : 'events'}, last {formatDateTime(issue.lastSeen)}
                  {issue.culprit && `, ${issue.culprit}`}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Section>
  );
}

/** The commit each deployment runs (docs/DECISIONS.md SA-92). */
export async function VersionsSection() {
  const deployments = await deploymentVersions();
  const here = process.env.NEXT_PUBLIC_BUILD_SHA ?? null;
  return (
    <Section id="versions-heading" title="Versions" description="The commit each deployment runs.">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div className="flex flex-col">
          <dt className="text-ink-muted">This deployment</dt>
          <dd className="font-mono text-ink">{short(here)}</dd>
        </div>
        {deployments.map((deployment) => (
          <div key={deployment.name} className="flex flex-col">
            <dt className="text-ink-muted">{deployment.name}</dt>
            <dd className={deployment.state === 'ok' ? 'font-mono text-ink' : undefined}>
              {deployment.state === 'unreachable' ? (
                <Outcome tone="bad">Couldn’t be reached</Outcome>
              ) : deployment.state === 'error' ? (
                <Outcome tone="bad">
                  {deployment.status === 503
                    ? 'Unhealthy: its database check failed'
                    : `Answered ${deployment.status}`}
                </Outcome>
              ) : (
                short(deployment.version)
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
