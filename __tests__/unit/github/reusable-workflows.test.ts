import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');

function readRepoFile(filePath: string): string {
  return fs.readFileSync(path.join(repoRoot, filePath), 'utf8');
}

describe('production reusable workflows', () => {
  it('keeps the review reusable workflow small and sandbox-safe', () => {
    const workflow = readRepoFile(
      '.github/workflows/reviewrouter-reusable.yml'
    );

    expect(workflow).toContain('workflow_call:');
    expect(workflow).toContain('runtime_ref:');
    expect(workflow).toContain('repository: 777genius/review-router');
    expect(workflow).toContain('ref: ${{ steps.runtime.outputs.runtime_ref }}');
    expect(workflow).toContain("eventName === 'merge_group'");
    expect(workflow).toContain("isMergeGroup ? 'merge_group'");
    expect(workflow).toContain('ReviewRouter merge queue check passed');
    expect(workflow).toContain('path: .reviewrouter-runtime');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('uses: actions/setup-node@v6');
    expect(workflow).toContain("node-version: '24'");
    expect(workflow).toContain('review_app_client_id:');
    expect(workflow).toContain('REVIEW_APP_PRIVATE_KEY:');
    expect(workflow).toContain('uses: actions/create-github-app-token@v3');
    expect(workflow).toContain("const crypto = require('node:crypto');");
    expect(workflow).toContain("staticEnv.FAIL_ON_NO_HEALTHY_PROVIDERS = 'true';");
    expect(workflow).toContain('npm install -g @openai/codex@0.125.0');
    expect(workflow).toContain('node .reviewrouter-runtime/dist/index.js');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('issues: write');
    expect(workflow).toContain('REVIEW_ROUTER_LEDGER_KEY');
    expect(workflow).toContain('CODEX_AUTH_JSON');
    expect(workflow).toContain('OPENROUTER_API_KEY');
    expect(workflow).toContain('reseed auth.json');
    expect(workflow).toContain('ReviewRouter skipped this fork pull request');
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('REVIEW_ROUTER_THREAD_RESOLVE_TOKEN');
    expect(workflow).not.toContain('repository: ${{');
  });

  it('keeps the interaction reusable workflow focused on /rr handling', () => {
    const workflow = readRepoFile(
      '.github/workflows/reviewrouter-interaction-reusable.yml'
    );

    expect(workflow).toContain('workflow_call:');
    expect(workflow).toContain('review_app_client_id:');
    expect(workflow).toContain('REVIEW_APP_PRIVATE_KEY:');
    expect(workflow).toContain('uses: actions/create-github-app-token@v3');
    expect(workflow).toContain('REVIEW_ROUTER_LEDGER_KEY');
    expect(workflow).toContain('actions: write');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('Preflight ReviewRouter interaction');
    expect(workflow).toContain('REVIEW_ROUTER_MODE: interaction-preflight');
    expect(workflow).toContain('REVIEW_ROUTER_MODE: interaction');
    expect(workflow).toContain('review_workflow_file:');
    expect(workflow).toContain('RR_REVIEW_WORKFLOW_FILE: ${{ inputs.review_workflow_file }}');
    expect(workflow).toContain('Invalid review_workflow_file');
    expect(workflow).toContain('REVIEW_ROUTER_REVIEW_WORKFLOW_FILE=${reviewWorkflowFile}');
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('REVIEW_ROUTER_THREAD_RESOLVE_TOKEN');
  });

  it('does not expose the removed resolve-conversation token in public surfaces', () => {
    expect(readRepoFile('action.yml')).not.toContain(
      'REVIEW_ROUTER_THREAD_RESOLVE_TOKEN'
    );
    expect(readRepoFile('README.md')).not.toContain(
      'REVIEW_ROUTER_THREAD_RESOLVE_TOKEN'
    );
  });
});
