// Read-only monitoring of the workflow channel against the deployed API.
// Resolves the channel tag to its exact SHA, reads the manifest at that SHA and
// runs the same compatibility check as channel promotion. It never deploys,
// promotes or rolls back anything.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkWorkflowChannelProtocolCompatibility } from './protocol-compat-check.mjs';

const REVIEW_ROUTER_API_ORIGIN = JSON.parse(
  fs.readFileSync(
    new URL('../src/config/review-router-endpoints.json', import.meta.url),
    'utf8'
  )
).apiOrigin;

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1048576,
  }).trim();
}

async function main() {
  const channel = process.env.CHANNEL_REF ?? 'workflow-v1';
  const protocolInfoUrl =
    process.env.PROTOCOL_INFO_URL ??
    `${REVIEW_ROUTER_API_ORIGIN}/api/action/v2/protocol-info`;
  let channelSha = '';
  let manifestSource = '';
  try {
    const line = git([
      'ls-remote',
      '--exit-code',
      'origin',
      `refs/tags/${channel}`,
    ]);
    channelSha = line.split('\t')[0] ?? '';
    if (!/^[a-f0-9]{40}$/.test(channelSha)) {
      throw new Error('workflow_channel_sha_invalid');
    }
    git(['fetch', '--no-tags', 'origin', `refs/tags/${channel}`]);
    manifestSource = git([
      'show',
      'FETCH_HEAD:src/control-plane/generated/review-action-v2/manifest.json',
    ]);
  } catch {
    // Unreadable channel state is reported through the manifest reason below.
    manifestSource = '';
  }
  const result = await checkWorkflowChannelProtocolCompatibility({
    manifestSource,
    protocolInfoUrl,
  });
  if (!result.compatible) {
    process.stderr.write(
      JSON.stringify({
        code: 'workflow_channel_protocol_check_failed',
        channel,
        channelSha,
        reason: result.reason,
      }) + '\n'
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    JSON.stringify({
      code: 'workflow_channel_protocol_check_passed',
      channel,
      channelSha,
      contract: result.contract,
    }) + '\n'
  );
}

await main();
