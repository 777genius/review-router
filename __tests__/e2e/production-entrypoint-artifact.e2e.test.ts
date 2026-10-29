import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import sodium from 'libsodium-wrappers';
import bundledProfiles from '../../src/control-plane/review-agent-profiles.json';

const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(
  repoRoot,
  '.github/workflows/reviewrouter-execution-reusable.yml'
);
const actionPath = path.join(repoRoot, 'action.yml');
const preloadPath = path.join(
  __dirname,
  'production-entrypoint-artifact-preload.cjs'
);
const runtimeConfigSentinel = '987654321';
const fakeIdToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
  JSON.stringify({
    iss: 'https://auth.openai.com',
    sub: 'artifact-smoke-user',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'artifact-smoke-account',
    },
  })
).toString('base64url')}.signature`;

type WorkflowStep = Readonly<{
  name?: string;
  run?: string;
}>;

type WorkflowDocument = Readonly<{
  jobs?: Readonly<
    Record<
      string,
      Readonly<{
        steps?: readonly WorkflowStep[];
      }>
    >
  >;
}>;

type ActionDocument = Readonly<{
  runs?: Readonly<{
    main?: string;
  }>;
}>;

type SmokeWitness = Readonly<{
  artifactPath: string;
  artifactSha256: string;
  expectedActionVersion: string;
  failure?: string;
  networkGuardsInstalled: boolean;
  workflowSchemaVersion: number;
  terminalComment: string;
  terminalCommitStatus: Readonly<{
    state: string;
    description: string;
    context: string;
  }>;
  runtimeConfig?: Readonly<{
    configVersion: number;
    providerLimit: string;
  }>;
  runnerProviderLimit: string | null;
  authWriteback: Readonly<{
    rotationPreserved: boolean;
  }>;
  modelRoute: Readonly<{
    transport: string;
    providerIndex: number;
    workflowSchemaVersion: number;
  }>;
  investigationRollout?: Readonly<{
    recording: string | null;
    shadow: string | null;
    contextCritic: string | null;
    verifiedClean: string | null;
    crossRevisionReplay: string | null;
    productionEffects: string | null;
  }>;
  calls: readonly Readonly<{
    method: string;
    origin: string;
    pathname: string;
  }>[];
}>;

describe('committed production entrypoint artifact', () => {
  const linuxTest =
    process.platform === 'linux' && process.arch === 'x64' ? it : it.skip;

  linuxTest.each(['long', 'short', 'expired'] as const)(
    'preserves %s rotated auth through sealed writeback and admits model work only for sufficient lifetime',
    async (lifetime) => {
      await sodium.ready;
      const writebackKeys = sodium.crypto_box_keypair();
      const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'reviewrouter-entrypoint-smoke-')
      );

      try {
        const runtimeArgument = readCommittedT0RuntimeArgument();
        assertPublicActionLauncherTargetsRuntime();

        const artifactPath = path.join(
          repoRoot,
          runtimeArgument.replace(/^\.reviewrouter-runtime\//, '')
        );
        const artifactSha256 = sha256(fs.readFileSync(artifactPath));
        const actionVersion = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repoRoot,
          encoding: 'utf8',
        }).trim();
        expect(actionVersion).toMatch(/^[a-f0-9]{40}$/);
        expect(
          execFileSync(
            'git',
            [
              'ls-files',
              '--error-unmatch',
              path.relative(repoRoot, artifactPath),
            ],
            { cwd: repoRoot, encoding: 'utf8' }
          ).trim()
        ).toBe('dist/index.js');
        const trackedArtifactPath = path.relative(repoRoot, artifactPath);
        expect(
          execFileSync('git', ['hash-object', '--', trackedArtifactPath], {
            cwd: repoRoot,
            encoding: 'utf8',
          }).trim()
        ).toBe(
          execFileSync(
            'git',
            ['rev-parse', `${actionVersion}:${trackedArtifactPath}`],
            { cwd: repoRoot, encoding: 'utf8' }
          ).trim()
        );

        const githubWorkspace = ensureDirectory(
          path.join(tempRoot, 'github-workspace')
        );
        const runnerTemp = ensureDirectory(path.join(tempRoot, 'runner-temp'));
        const home = ensureDirectory(path.join(tempRoot, 'home'));
        fs.symlinkSync(
          repoRoot,
          path.join(githubWorkspace, '.reviewrouter-runtime'),
          'dir'
        );

        const eventPath = path.join(tempRoot, 'event.json');
        const outputPath = path.join(tempRoot, 'github-output');
        const witnessPath = path.join(tempRoot, 'witness.json');
        const codexLogPath = path.join(tempRoot, 'codex.log');
        const gitLogPath = path.join(tempRoot, 'git.log');
        const fakeBin = ensureDirectory(path.join(tempRoot, 'fake-bin'));
        fs.symlinkSync(process.execPath, path.join(fakeBin, 'node'));
        const fakeCodexPath = path.join(fakeBin, 'codex');
        const fakeGitPath = path.join(fakeBin, 'git');
        const npmLogPath = path.join(tempRoot, 'npm.log');
        const fixturePreloadPath = path.join(
          tempRoot,
          'approved-agent-preload.cjs'
        );

        fs.writeFileSync(
          eventPath,
          JSON.stringify({
            repository: { full_name: 'sandbox/repository' },
            pull_request: {
              number: 17,
              head: {
                ref: 'artifact-smoke',
                repo: { full_name: 'sandbox/repository' },
                sha: 'a'.repeat(40),
              },
            },
          })
        );
        fs.writeFileSync(outputPath, '');
        writeFakeCodex(fakeCodexPath, codexLogPath, lifetime);
        writeFakeGit(fakeGitPath, gitLogPath);
        const approvedProfiles = bundledProfiles.filter(
          (profile) =>
            profile.agentKind === 'codex' &&
            profile.modelTransports.includes('provider_api')
        );
        expect(
          approvedProfiles.map((profile) => profile.profileRef).sort()
        ).toEqual(['codex-default', 'codex-skills-v1']);
        const profile = approvedProfiles.find(
          (profile) => profile.profileRef === 'codex-default'
        )!;
        const skillsProfile = approvedProfiles.find(
          (profile) => profile.profileRef === 'codex-skills-v1'
        )!;
        expect(profile).not.toHaveProperty('reviewSkillsVersion');
        expect(skillsProfile).toMatchObject({
          reviewSkillsVersion: 1,
          binarySha256: profile.binarySha256,
          packageVersion: profile.packageVersion,
        });
        writeFakeNpm(
          path.join(fakeBin, 'npm'),
          fakeCodexPath,
          npmLogPath,
          profile.packageVersion
        );
        // Keep the committed artifact and its hash witness intact. Substitute only
        // synthetic qualification data at the module-load seam; this smoke does
        // not certify a real Codex binary. The real digest guard
        // verifies our harmless fixture executable rather than a provider binary.
        // The retained legacy and Skills profiles qualify the same executable;
        // require exactly those two digest occurrences before substituting both.
        fs.writeFileSync(
          fixturePreloadPath,
          `
require(${JSON.stringify(preloadPath)});
const Module = require('node:module');
const fs = require('node:fs');
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function(source, filename) {
  if (fs.realpathSync(filename) === ${JSON.stringify(fs.realpathSync(artifactPath))}) {
    const qualifiedDigest = ${JSON.stringify(profile.binarySha256)};
    if (source.split(qualifiedDigest).length !== ${approvedProfiles.length + 1}) throw new Error('artifact_smoke_profile_fixture_mismatch');
    source = source.replaceAll(qualifiedDigest, ${JSON.stringify(sha256(fs.readFileSync(fakeCodexPath)))});
  }
  return originalCompile.call(this, source, filename);
};
`
        );

        const result = spawnSync(process.execPath, [runtimeArgument], {
          cwd: githubWorkspace,
          encoding: 'utf8',
          timeout: 20_000,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            PATH: fakeBin,
            HOME: home,
            NODE_OPTIONS: `--require=${fixturePreloadPath}`,
            CI: 'true',
            GITHUB_ACTIONS: 'true',
            GITHUB_EVENT_NAME: 'pull_request',
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_OUTPUT: outputPath,
            GITHUB_REPOSITORY: 'sandbox/repository',
            GITHUB_WORKSPACE: githubWorkspace,
            RUNNER_TEMP: runnerTemp,
            REVIEWROUTER_ACTION_V2_MODE: 't0',
            REVIEWROUTER_ACTION_VERSION: actionVersion,
            REVIEWROUTER_API_URL: 'https://control-plane.reviewrouter.test',
            REVIEWROUTER_CONTROL_PLANE_URL:
              'https://control-plane.reviewrouter.test',
            REVIEWROUTER_OIDC_AUDIENCE: 'reviewrouter',
            REVIEWROUTER_RUNTIME_CONFIG_MODE: 'oidc',
            REVIEWROUTER_STATIC_CONFIG_FALLBACK: 'false',
            REVIEWROUTER_CODEX_BINARY: fakeCodexPath,
            REVIEW_ROUTER_MODE: 'codex-oauth-rotating',
            INPUT_API_URL: 'https://control-plane.reviewrouter.test',
            INPUT_CONTROL_PLANE_URL: 'https://control-plane.reviewrouter.test',
            INPUT_PROVIDER_INSTANCE_ID: 'codex-rotating:artifact-smoke',
            INPUT_WORKFLOW_SCHEMA_VERSION: '5',
            INPUT_AUTH_JSON: JSON.stringify({
              auth_mode: 'chatgpt',
              tokens: {
                access_token: 'synthetic-expired-access-token',
                refresh_token: 'fake-refresh-token',
                id_token: fakeIdToken,
              },
              last_refresh: '2026-08-04T00:00:00.000Z',
            }),
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-oidc-request-token',
            ACTIONS_ID_TOKEN_REQUEST_URL:
              'https://token.actions.githubusercontent.com/token',
            RR_ARTIFACT_SMOKE_EXPECTED_ACTION_VERSION: actionVersion,
            RR_ARTIFACT_SMOKE_EXPECTED_ARTIFACT: artifactPath,
            RR_ARTIFACT_SMOKE_EXPECTED_ARTIFACT_SHA256: artifactSha256,
            RR_ARTIFACT_SMOKE_PUBLIC_KEY: Buffer.from(
              writebackKeys.publicKey
            ).toString('base64'),
            RR_ARTIFACT_SMOKE_PRIVATE_KEY: Buffer.from(
              writebackKeys.privateKey
            ).toString('base64'),
            RR_ARTIFACT_SMOKE_WITNESS_PATH: witnessPath,
            RR_ARTIFACT_SMOKE_APPROVED_AGENT_JSON: JSON.stringify({
              ...profile,
              binarySha256: sha256(fs.readFileSync(fakeCodexPath)),
            }),
          },
        });

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(1);
        const witness = JSON.parse(
          fs.readFileSync(witnessPath, 'utf8')
        ) as SmokeWitness;
        expect(witness.failure).toBeUndefined();
        expect(result.stdout).toContain(
          'review_action_v2_terminal_result_missing'
        );
        expect(result.stdout).not.toContain('Review completed successfully');

        expect(witness).toMatchObject({
          artifactPath: fs.realpathSync(artifactPath),
          artifactSha256,
          expectedActionVersion: actionVersion,
          networkGuardsInstalled: true,
          workflowSchemaVersion: 5,
          terminalComment: expect.stringContaining(
            'did not obtain a terminal review result from the provider'
          ),
          terminalCommitStatus: {
            state: 'error',
            description: 'Review failed: no terminal provider result.',
            context: 'ReviewRouter',
          },
          runtimeConfig: {
            configVersion: 4242,
            providerLimit: runtimeConfigSentinel,
          },
          // Only the actual production runner applies the admitted environment.
          // The deliberately invalid limit then stops it before any model I/O.
          runnerProviderLimit:
            lifetime === 'long' ? runtimeConfigSentinel : null,
          authWriteback: { rotationPreserved: true },
          modelRoute: {
            transport: 'runner_local_responses',
            providerIndex: 0,
            workflowSchemaVersion: 2,
          },
          investigationRollout: {
            recording: lifetime === 'long' ? '1' : null,
            shadow: lifetime === 'long' ? '1' : null,
            contextCritic: lifetime === 'long' ? '1' : null,
            verifiedClean: lifetime === 'long' ? '1' : null,
            crossRevisionReplay: lifetime === 'long' ? '1' : null,
            productionEffects: lifetime === 'long' ? '1' : null,
          },
        });
        expect(
          witness.calls.map(
            (call) => `${call.method} ${call.origin}${call.pathname}`
          )
        ).toEqual([
          'GET https://token.actions.githubusercontent.com/token',
          'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/prelease',
          'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/finalize',
          'GET https://api.github.com/repos/sandbox/repository/actions/secrets/public-key',
          'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/writeback-preflight',
          'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/writeback',
          'POST https://control-plane.reviewrouter.test/api/action/v1/codex-oauth/checkout-token',
          'GET https://token.actions.githubusercontent.com/token',
          'POST https://control-plane.reviewrouter.test/api/action/v2/review-runs/authorize',
          'POST https://control-plane.reviewrouter.test/api/action/v2/model-route/checkout',
          'GET https://token.actions.githubusercontent.com/token',
          'POST https://control-plane.reviewrouter.test/api/action/v1/session/exchange',
          'POST https://control-plane.reviewrouter.test/api/action/v1/comment-token',
          'GET https://api.github.com/repos/sandbox/repository/issues/17/comments',
          'POST https://api.github.com/repos/sandbox/repository/issues/17/comments',
          'POST https://api.github.com/repos/sandbox/repository/statuses/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ]);
        expect(readLog(npmLogPath)).toEqual([
          'approved-install',
          'approved-install',
        ]);
        expect(readLog(codexLogPath)).toEqual([
          'app-server',
          'initialize',
          'initialized',
          'account/read',
        ]);
        if (lifetime === 'long') {
          expect(readLog(gitLogPath)).toEqual([
            'init',
            'config',
            'config',
            'config',
            'remote',
            'fetch',
            'checkout',
          ]);
        } else {
          expect(fs.existsSync(gitLogPath)).toBe(false);
        }
        expect(
          fs.readdirSync(path.join(home, '.reviewrouter', 'runtime'))
        ).toEqual([]);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    30_000
  );
});

function readCommittedT0RuntimeArgument(): string {
  const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'), {
    schema: yaml.JSON_SCHEMA,
  }) as WorkflowDocument;
  const step = workflow.jobs?.review?.steps?.find(
    (candidate) => candidate.name === 'Run ReviewRouter T0'
  );
  const match = /^node (\.reviewrouter-runtime\/dist\/index\.js)$/.exec(
    step?.run ?? ''
  );

  expect(match).not.toBeNull();
  return match![1];
}

function assertPublicActionLauncherTargetsRuntime(): void {
  const action = yaml.load(fs.readFileSync(actionPath, 'utf8'), {
    schema: yaml.JSON_SCHEMA,
  }) as ActionDocument;
  const launcher = action.runs?.main;

  expect(launcher).toBe('action-dist/index.cjs');
  expect(
    execFileSync('git', ['ls-files', '--error-unmatch', launcher!], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
  ).toBe(launcher);
  expect(fs.readFileSync(path.join(repoRoot, launcher!), 'utf8')).toContain(
    '(actionPath, "dist", "index.js")'
  );
}

function writeFakeCodex(
  filePath: string,
  logPath: string,
  lifetime: 'long' | 'short' | 'expired'
): void {
  writeExecutable(
    filePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
if (JSON.stringify(args) !== '["app-server"]') {
  fs.appendFileSync(${JSON.stringify(logPath)}, 'unexpected-cli-invocation\\n');
  process.exit(97);
}
fs.appendFileSync(${JSON.stringify(logPath)}, 'app-server\\n');
let phase = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  const expected = ['initialize', 'initialized', 'account/read'][phase++];
  fs.appendFileSync(${JSON.stringify(logPath)}, request.method + '\\n');
  if (!expected || request.method !== expected) process.exit(97);
  if (request.method === 'initialize') {
    if (request.id !== 1) process.exit(97);
    console.log(JSON.stringify({ id: request.id, result: {} }));
  } else if (request.method === 'account/read') {
    if (request.id !== 2 || JSON.stringify(request.params) !== '{"refreshToken":true}') process.exit(97);
    const authPath = path.join(process.env.CODEX_HOME, 'auth.json');
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    auth.tokens.access_token = Buffer.from('{}').toString('base64url') + '.' +
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ${lifetime === 'long' ? 3600 : lifetime === 'short' ? 30 : -30} })).toString('base64url') + '.synthetic-signature';
    auth.tokens.refresh_token = 'synthetic-refreshed-token';
    auth.last_refresh = new Date().toISOString();
    fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
    console.log(JSON.stringify({ id: request.id, result: { account: { type: 'chatgpt' } } }));
  }
});
`
  );
}

function writeFakeNpm(
  filePath: string,
  codexPath: string,
  logPath: string,
  packageVersion: string
): void {
  writeExecutable(
    filePath,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
if (!prefix || JSON.stringify(args) !== JSON.stringify([
  'install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund',
  '--ignore-scripts', ${JSON.stringify('@openai/codex@' + packageVersion)}
])) process.exit(96);
const target = path.join(prefix, 'node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(${JSON.stringify(codexPath)}, target);
fs.chmodSync(target, 0o755);
fs.appendFileSync(${JSON.stringify(logPath)}, 'approved-install\\n');
`
  );
}

function writeFakeGit(filePath: string, logPath: string): void {
  writeExecutable(
    filePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const operation = ['init', 'config', 'remote', 'fetch', 'checkout'].find((name) =>
  args.includes(name)
) || 'unexpected';
fs.appendFileSync(${JSON.stringify(logPath)}, operation + '\\n');
if (operation === 'init') fs.mkdirSync(path.join(process.cwd(), '.git'), { recursive: true });
process.exitCode = operation === 'unexpected' ? 98 : 0;
`
  );
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function ensureDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function readLog(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
