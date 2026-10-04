import * as core from './actions/core';
import { GitHubActionsOidcTokenProvider } from './codex-oauth/github-actions-oidc';
import { createNewtestJobTransport } from './control-plane/newtest-one-shot-job-transport';

const env = process.env;
const oidc = new GitHubActionsOidcTokenProvider();
async function main(): Promise<void> {
  const transport = createNewtestJobTransport({
    identity: {
      repository: env.GITHUB_REPOSITORY ?? '',
      repositoryId: env.GITHUB_REPOSITORY_ID ?? '',
      headRepository: env.RR_HEAD_REPOSITORY ?? '',
      eventName: env.GITHUB_EVENT_NAME ?? '',
      runId: env.GITHUB_RUN_ID ?? '',
      runAttempt: env.GITHUB_RUN_ATTEMPT ?? '',
      headSha: env.RR_HEAD_SHA ?? '',
      pullRequestNumber: env.RR_PR_NUMBER ?? '',
      workflowRepository: env.RR_WORKFLOW_REPOSITORY ?? '',
      workflowSha: env.RR_WORKFLOW_SHA ?? '',
    },
    fetch,
    requestOidc: (audience) => oidc.requestToken(audience),
  });
  const evidenceHash = await transport.runOnce();
  core.setOutput('newtest_evidence_hash', evidenceHash);
}

void main().catch(() => {
  // Never interpolate transport/provider errors, bodies, OIDC or credentials.
  core.setFailed(
    'One-shot TEST transport failed; no automatic retry or ordinary review fallback.'
  );
});
