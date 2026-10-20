import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import yaml from 'js-yaml';

const REVIEW_ROUTER_API_ORIGIN = (
  JSON.parse(
    fs.readFileSync(
      new URL('../src/config/review-router-endpoints.json', import.meta.url),
      'utf8'
    )
  ) as { apiOrigin: string }
).apiOrigin;

type PromotionPhase =
  | 'validate'
  | 'fetch'
  | 'abi'
  | 'precondition'
  | 'push'
  | 'readback';
let phase: PromotionPhase = 'validate';
let pushIssued = false;
let pushCompleted = false;

function need(value: unknown): asserts value {
  if (!value) throw new Error('workflow_channel_promotion_rejected');
}

function record(value: unknown): Record<string, unknown> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function validateAbi(source: string): void {
  const workflow = record(yaml.load(source, { schema: yaml.JSON_SCHEMA }));
  const events = record(workflow.on);
  need(isDeepStrictEqual(Object.keys(events), ['workflow_call']));
  const call = record(events.workflow_call);
  need(isDeepStrictEqual(Object.keys(call), ['inputs']));
  const inputs = record(call.inputs);
  need(
    isDeepStrictEqual(Object.keys(inputs).sort(), [
      'control_plane_url',
      'pr_number',
      'review_head_sha',
      'review_request_id',
    ])
  );
  for (const name of ['review_request_id', 'pr_number', 'review_head_sha']) {
    const input = record(inputs[name]);
    need(input.required === true && input.type === 'string');
  }
  const optional = record(inputs.control_plane_url);
  need(
    (optional.required === false || optional.required === undefined) &&
      optional.type === 'string' &&
      optional.default === REVIEW_ROUTER_API_ORIGIN
  );
  need(isDeepStrictEqual(workflow.permissions, {}));
  const jobs = record(workflow.jobs);
  need(isDeepStrictEqual(Object.keys(jobs), ['review']));
  const review = record(jobs.review);
  need(review['runs-on'] === 'ubuntu-latest');
  need(
    isDeepStrictEqual(review.permissions, {
      contents: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    })
  );
}

function git(args: string[], env = process.env): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1048576,
  }).trim();
}

function promote(): void {
  const version = process.env.TARGET_VERSION ?? '';
  const expected = process.env.EXPECTED_CURRENT_SHA ?? '';
  need(
    process.env.GITHUB_REPOSITORY === '777genius/review-router' &&
      process.env.GITHUB_REF === 'refs/heads/main'
  );
  need(
    /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(version) && /^[a-f0-9]{40}$/.test(expected)
  );
  // Fetch public data only; execute the reviewed helper from main, never target code.
  phase = 'fetch';
  git(['fetch', '--no-tags', 'origin', `refs/tags/${version}`]);
  const target = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  need(/^[a-f0-9]{40}$/.test(target));
  phase = 'abi';
  validateAbi(
    git(['show', `${target}:.github/workflows/reviewrouter-runtime.yml`])
  );
  phase = 'precondition';
  const token = process.env.GITHUB_TOKEN;
  need(token);
  const release = record(
    JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          '--hostname',
          'github.com',
          `repos/777genius/review-router/releases/tags/${version}`,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 1048576,
        }
      )
    )
  );
  need(
    release.tag_name === version &&
      release.draft === false &&
      release.prerelease === false &&
      typeof release.published_at === 'string' &&
      Number.isFinite(Date.parse(release.published_at))
  );
  need(
    git(['ls-remote', '--exit-code', 'origin', 'refs/tags/workflow-v1']) ===
      `${expected}\trefs/tags/workflow-v1`
  );
  // Keep the token out of arguments, persistent Git config and output.
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0:
      'AUTHORIZATION: basic ' +
      Buffer.from(`x-access-token:${token}`).toString('base64'),
  };
  phase = 'push';
  pushIssued = true;
  git(
    [
      'push',
      `--force-with-lease=refs/tags/workflow-v1:${expected}`,
      'origin',
      `${target}:refs/tags/workflow-v1`,
    ],
    env
  );
  pushCompleted = true;
  phase = 'readback';
  need(
    git(['ls-remote', '--exit-code', 'origin', 'refs/tags/workflow-v1']) ===
      `${target}\trefs/tags/workflow-v1`
  );
  process.stdout.write(
    JSON.stringify({
      channel: 'workflow-v1',
      version,
      previousSha: expected,
      targetSha: target,
      promoted: true,
    }) + '\n'
  );
}

try {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--validate') {
    const candidate = args[1];
    need(typeof candidate === 'string');
    validateAbi(fs.readFileSync(candidate, 'utf8'));
    process.stdout.write('workflow_channel_abi_compatible\n');
  } else {
    need(args.length === 0);
    promote();
  }
} catch {
  // A failed/unknown publication is not automatically retried.
  process.stderr.write(
    JSON.stringify({
      code: 'workflow_channel_promotion_rejected',
      phase,
      pushIssued,
      pushCompleted,
      outcome: pushIssued ? 'unknown' : 'not_issued',
    }) + '\n'
  );
  process.exitCode = 1;
}
