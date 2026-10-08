import { createServer, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSync } from 'esbuild';
import { GitHubClient } from '../../src/github/client';
import { createScmReadGitHubClient } from '../../src/review-orchestration/infrastructure/production-t0-review-runner';
import {
  CiReviewProgressPublisher,
  CiOrchestrationProgressReporter,
} from '../../src/codex-oauth/ci-review-progress';
import {
  TerminalOutcomePublicationUseCase,
  createPublicationGitHubClient,
} from '../../src/codex-oauth/terminal-outcome-publication';
import { CodexProvider } from '../../src/providers/codex';
import {
  createPreparedProviderInvocation,
  ProviderKind,
} from '../../src/providers/prepared-invocation';

// This same typed file is the bounded compiled-main observer; sentinels originate here.
if (process.argv[2] === '--source-main') {
  const names = [
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'CODEX_AUTH_JSON',
    'CODEX_CONFIG_TOML',
    'OPENAI_API_KEY',
    'CODEX_HOME',
    'INPUT_AUTH-JSON',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENROUTER_API_KEY',
    'INPUT_OPENROUTER_API_KEY',
  ];
  for (const name of names)
    process.env[name] = `nonsecret-fixture-${randomUUID()}`;
  process.env.REVIEW_ROUTER_MODE = 'account-gateway';
  process.env.REVIEWROUTER_ACTION_V2_MODE = 'invalid-fixture';
  process.env.REVIEW_ROUTER_SUPPRESS_FAILURE_COMMENT = '1';
  process.once('beforeExit', () =>
    writeFileSync(
      process.argv[4],
      JSON.stringify({
        remaining: names.filter((name) => process.env[name] !== undefined),
        exitCode: process.exitCode,
      })
    )
  );
  createRequire(__filename)(process.argv[3]);
} else {
  const until = async (condition: () => boolean | Promise<boolean>) => {
    const end = Date.now() + 4_000;
    while (!(await condition())) {
      if (Date.now() >= end) throw new Error('fixture_observation_timeout');
      await delay(10);
    }
  };
  const exists = async (file: string) =>
    fs.access(file).then(
      () => true,
      () => false
    );
  const exited = async (pid: number) => {
    try {
      return (
        (await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] === 'Z'
      );
    } catch (error) {
      if (
        ['ENOENT', 'ESRCH'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        )
      )
        return true;
      throw error;
    }
  };

  describe('account gateway lifecycle at HTTP and owned process boundaries', () => {
    test.each(['abort', 'deadline', 'retry sleep'] as const)(
      'runner SCM token-provider transport rejects boundedly on %s',
      async (scenario) => {
        const initialToken = `nonsecret-fixture-${randomUUID()}`;
        const refreshedToken = `nonsecret-fixture-${randomUUID()}`;
        const authorizations: string[] = [];
        const held: ServerResponse[] = [];
        const server = createServer((req, res) => {
          authorizations.push(String(req.headers.authorization));
          res.setHeader('content-type', 'application/json');
          if (authorizations.length === 1) {
            res.statusCode = 401;
            res.end(JSON.stringify({ message: 'fixture refresh required' }));
          } else if (scenario === 'retry sleep') {
            res.statusCode = 503;
            res.setHeader('retry-after', '10');
            res.end(
              JSON.stringify({ message: 'fixture temporarily unavailable' })
            );
          } else {
            // No response bytes or release: settlement must come from the client.
            held.push(res);
          }
        });
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve)
        );
        const stopped = new AbortController();
        let pending: Promise<void> | undefined;
        try {
          const address = server.address();
          if (!address || typeof address === 'string')
            throw new Error('fixture_address');
          const origin = `http://127.0.0.1:${address.port}`;
          const expiresAt = new Date(Date.now() + 60_000).toISOString();
          const refresh = jest.fn(async () => ({
            token: refreshedToken,
            expiresAt,
          }));
          // Same composition used by runInWorkspace, including its inner token hook.
          const actual = createScmReadGitHubClient({
            token: initialToken,
            expiresAt,
            refresh,
            signal: stopped.signal,
            timeoutMs: scenario === 'deadline' ? 500 : 30_000,
          });
          actual.octokit.hook.before('request', (options) => {
            options.baseUrl = origin;
            options.url = String(options.url).replace(
              /^https:\/\/api\.github\.com/,
              origin
            );
          });
          let settled = false;
          let observed: unknown;
          const startedAt = Date.now();
          pending = actual.octokit.rest.pulls
            .get({ owner: 'fixture', repo: 'repo', pull_number: 1 })
            .then(
              (value) => {
                observed = value;
                settled = true;
              },
              (error: unknown) => {
                observed = error;
                settled = true;
              }
            );
          await until(() => authorizations.length === 2);
          expect(refresh).toHaveBeenCalledTimes(1);
          expect(authorizations).toEqual([
            `Bearer ${initialToken}`,
            `Bearer ${refreshedToken}`,
          ]);
          if (scenario === 'retry sleep') await delay(50);
          const abortAt = Date.now();
          if (scenario !== 'deadline') stopped.abort();
          await until(() => settled);
          await pending;
          expect(
            Date.now() - (scenario === 'deadline' ? startedAt : abortAt)
          ).toBeLessThan(2_000);
          expect(observed).toEqual(
            expect.objectContaining({
              name: expect.stringMatching(/^(AbortError|TimeoutError)$/),
            })
          );
          expect(stopped.signal.aborted).toBe(scenario !== 'deadline');
          expect(authorizations).toHaveLength(2);
          expect(held).toHaveLength(scenario === 'retry sleep' ? 0 : 1);
          expect(held.every((response) => !response.writableEnded)).toBe(true);
        } finally {
          stopped.abort();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await pending;
        }
      }
    );

    test.each(['active completion', 'queued completion'])(
      '%s cannot mutate after abort; cancellation drains',
      async (scenario) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p70-http-'));
        const held: ServerResponse[] = [];
        const requests: {
          channel: string;
          method: string;
          url: string;
          body: string;
        }[] = [];
        const headSha = 'a'.repeat(40);
        const marker = `<!-- reviewrouter:codex-oauth:terminal:${headSha}:failed -->`;
        const server = createServer(async (req, res) => {
          let body = '';
          for await (const chunk of req) body += String(chunk);
          const channel = String(req.headers['x-fixture-channel']);
          requests.push({ channel, method: req.method!, url: req.url!, body });
          res.setHeader('content-type', 'application/json');
          if (
            (channel === 'transport' ||
              (channel === 'normal' && held.length < 2)) &&
            req.method === 'GET'
          ) {
            held.push(res);
            return;
          }
          res.end(req.method === 'GET' ? '[]' : '{}');
        });
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve)
        );
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('fixture_address');
        const origin = `http://127.0.0.1:${address.port}`;
        // Existing GitHub/Octokit port: real HTTP, deliberately deliver a late normal list.
        const client = (channel: string, signal?: AbortSignal) => {
          const github = new GitHubClient('nonsecret-fixture');
          github.octokit.hook.wrap('request', (request, options) => {
            Object.assign(options, {
              baseUrl: origin,
              url: String(options.url).replace(
                /^https:\/\/api\.github\.com/,
                origin
              ),
              headers: { ...options.headers, 'x-fixture-channel': channel },
              request: { ...options.request, signal, timeout: 1_000 },
            });
            return request(options);
          });
          return github.octokit;
        };
        const normal = client('normal');
        const abort = new AbortController();
        const publisher = (octokit: typeof normal, signal: AbortSignal) => {
          const input = {
            repository: 'fixture/repo',
            pullRequestNumber: 1,
            commentEligible: true,
            signal,
            summaryPath: path.join(root, 'summary'),
            info: () => undefined,
            warning: () => undefined,
            github: {
              listComments: async () =>
                (
                  await octokit.rest.issues.listComments({
                    owner: 'fixture',
                    repo: 'repo',
                    issue_number: 1,
                  })
                ).data,
              createComment: async (value: { body: string }) => {
                await octokit.rest.issues.createComment({
                  owner: 'fixture',
                  repo: 'repo',
                  issue_number: 1,
                  body: value.body,
                });
              },
              updateComment: async (value: {
                body: string;
                commentId: number;
              }) => {
                await octokit.rest.issues.updateComment({
                  owner: 'fixture',
                  repo: 'repo',
                  comment_id: value.commentId,
                  body: value.body,
                });
              },
            },
          };
          return new CiReviewProgressPublisher(input);
        };
        const terminal = (octokit: typeof normal, signal: AbortSignal) => {
          const input = {
            context: {
              repository: 'fixture/repo',
              pullRequestNumber: 1,
              headSha,
            },
            signal,
            logger: { info: () => undefined, warning: () => undefined },
            github: {
              listPullRequestComments: async () =>
                (
                  await octokit.rest.issues.listComments({
                    owner: 'fixture',
                    repo: 'repo',
                    issue_number: 1,
                  })
                ).data,
              deletePullRequestComment: async (value: {
                commentId: number;
              }) => {
                await octokit.rest.issues.deleteComment({
                  owner: 'fixture',
                  repo: 'repo',
                  comment_id: value.commentId,
                });
              },
              createPullRequestComment: async (value: { body: string }) => {
                await octokit.rest.issues.createComment({
                  owner: 'fixture',
                  repo: 'repo',
                  issue_number: 1,
                  body: value.body,
                });
              },
              updatePullRequestComment: async (value: {
                commentId: number;
                body: string;
              }) => {
                await octokit.rest.issues.updateComment({
                  owner: 'fixture',
                  repo: 'repo',
                  comment_id: value.commentId,
                  body: value.body,
                });
              },
              createCommitStatus: async () => {
                await octokit.rest.repos.createCommitStatus({
                  owner: 'fixture',
                  repo: 'repo',
                  sha: headSha,
                  state: 'error',
                });
              },
            },
          };
          return new TerminalOutcomePublicationUseCase(input);
        };
        try {
          const progress = new CiOrchestrationProgressReporter(
            publisher(normal, abort.signal)
          );
          if (scenario === 'queued completion')
            progress.report({ type: 'initialized', workSlots: [] });
          const complete = progress.finish('complete');
          const clear = terminal(normal, abort.signal)
            .clear({ reason: 'review_completed' })
            .then(
              () => 'cleared',
              () => 'aborted'
            );
          await until(() => held.length === 2);
          abort.abort(new Error('account_gateway_cancelled'));
          const reportingSignal = AbortSignal.timeout(2_000);
          const reporting = client('reporting', reportingSignal);
          const finish: (
            terminal: 'cancelled',
            channel?: CiReviewProgressPublisher
          ) => Promise<void> = progress.finish.bind(progress);
          const cancelled = finish(
            'cancelled',
            publisher(reporting, reportingSignal)
          );
          for (const response of held)
            response.end(JSON.stringify([{ id: 7, body: marker }]));
          await complete;
          await cancelled;
          expect(await clear).toBe('aborted');
          await terminal(reporting, reportingSignal).post({
            marker,
            body: 'Review cancelled',
            stepSummary: '',
            logLabel: 'cancelled',
            commitStatus: {
              state: 'error',
              description: 'cancelled',
              context: 'ReviewRouter',
            },
          });
          expect(
            requests.filter((r) => r.channel === 'normal' && r.method !== 'GET')
          ).toEqual([]);
          const progressWrites = requests
            .filter((r) => r.url.endsWith('/comments') && r.method === 'POST')
            .map((r) => r.body);
          expect(
            progressWrites.some((body) =>
              body.includes('**Phase:** Review cancelled')
            )
          ).toBe(true);
          expect(
            progressWrites.some((body) =>
              body.includes('**Phase:** Review complete')
            )
          ).toBe(false);
          expect(
            requests.some(
              (r) =>
                r.channel === 'reporting' &&
                r.url.includes('/statuses/') &&
                r.method === 'POST'
            )
          ).toBe(true);
          expect(await exists(path.join(root, 'summary'))).toBe(false);
          if (scenario === 'active completion') {
            for (const kind of ['abort', 'deadline']) {
              const stopped = new AbortController();
              const actual = createPublicationGitHubClient(
                'nonsecret-fixture',
                {
                  signal: stopped.signal,
                  timeoutMs: kind === 'deadline' ? 100 : 1_000,
                }
              );
              actual.octokit.hook.before('request', (options) => {
                options.baseUrl = origin;
                options.url = String(options.url).replace(
                  /^https:\/\/api\.github\.com/,
                  origin
                );
                options.headers['x-fixture-channel'] = 'transport';
              });
              const before = requests.filter(
                (request) => request.channel === 'transport'
              ).length;
              let settled = false;
              let observed: unknown;
              const pending = actual.octokit.rest.issues
                .listComments({
                  owner: 'fixture',
                  repo: 'repo',
                  issue_number: 1,
                })
                .then(
                  (value) => {
                    observed = value;
                    settled = true;
                  },
                  (error: unknown) => {
                    observed = error;
                    settled = true;
                  }
                );
              await until(
                () =>
                  requests.filter((request) => request.channel === 'transport')
                    .length ===
                  before + 1
              );
              if (kind === 'abort') stopped.abort();
              await until(() => settled);
              await pending;
              expect(observed).toEqual(
                expect.objectContaining({
                  name: expect.stringMatching(/^(AbortError|TimeoutError)$/),
                })
              );
              expect(String(observed)).toMatch(/abort|timeout|signal/i);
            }
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    );

    test.each(['abort', 'timeout', 'output cap'])(
      'Codex %s drains close before prompt/resource cleanup',
      async (cause) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p70-child-'));
        const oldTmp = process.env.TMPDIR;
        process.env.TMPDIR = root;
        const script = path.join(root, 'owned-child.sh');
        // The separately owned pipe holder delays close after the leader/tool group exits.
        // It is explicitly released/killed here; this is not escaped-child certification.
        await fs.writeFile(
          script,
          `#!/bin/sh\necho $$ > "$1/leader"\nreadlink /proc/$$/fd/0 > "$1/prompt"\nsleep 30 &\necho $! > "$1/tool"\nsetsid sh -c 'echo $$ > "$1/holder"; while [ ! -f "$1/release" ]; do sleep 0.02; done' sh "$1" &\nwhile [ ! -f "$1/trigger" ]; do sleep 0.02; done\nif [ "$2" = cap ]; then head -c 9000000 /dev/zero; fi\nwait\n`
        );
        const abort = new AbortController();
        const provider = new CodexProvider('fixture-model', {
          accountGateway: {
            baseUrl: 'http://127.0.0.1:1',
            environment: {},
            configuration: [],
            actualModel: () => undefined,
            dispose: async () => undefined,
          },
        });
        type Request = Awaited<
          ReturnType<CodexProvider['prepareInvocation']>
        >['request'];
        const request: Request = {
          binary: '/bin/sh',
          prompt: 'nonsecret fixture',
          cwd: root,
          argsTemplate: [
            script,
            root,
            cause === 'output cap' ? 'cap' : 'hold',
            '{reviewrouter_output_file}',
          ],
          outputSchema: {},
          validateOutputLocally: false,
          environment: { PATH: '/usr/bin:/bin', HOME: root },
          eventAudit: false,
          jsonEvents: false,
          auditMode: 'off',
          optionalAgenticRetryMaxPromptTokens: 0,
          acceptReviewOutputOnNonZero: false,
        };
        const invocation = createPreparedProviderInvocation({
          providerKind: ProviderKind.CodexCli,
          providerName: provider.name,
          requestedModel: 'fixture-model',
          timeoutMs: cause === 'timeout' ? 1_000 : 5_000,
          request,
        });
        const resource = path.join(root, 'owned-resource');
        await fs.writeFile(resource, 'held');
        let settled = false;
        const result = provider
          .executePreparedInvocation(invocation, undefined, abort.signal)
          .then(
            () => 'unexpected success',
            (error: unknown) => String(error)
          )
          .finally(async () => {
            settled = true;
            await fs.rm(resource);
          });
        try {
          await until(() => exists(path.join(root, 'holder')));
          const leader = Number(
            await fs.readFile(path.join(root, 'leader'), 'utf8')
          );
          const tool = Number(
            await fs.readFile(path.join(root, 'tool'), 'utf8')
          );
          const prompt = (
            await fs.readFile(path.join(root, 'prompt'), 'utf8')
          ).trim();
          await fs.writeFile(path.join(root, 'trigger'), 'go');
          if (cause === 'abort') abort.abort(new Error('fixture abort'));
          await until(() => exited(leader));
          await until(() => exited(tool));
          expect(await exited(tool)).toBe(true);
          await delay(50);
          expect(settled).toBe(false);
          expect(await exists(prompt)).toBe(true);
          expect(await exists(resource)).toBe(true);
          await fs.writeFile(path.join(root, 'release'), 'close');
          expect(await result).toMatch(
            cause === 'abort'
              ? /abort/i
              : cause === 'timeout'
                ? /timed out/
                : /output_bound/
          );
          expect(await exists(prompt)).toBe(false);
          expect(await exists(resource)).toBe(false);
        } finally {
          for (const name of ['leader', 'holder']) {
            if (await exists(path.join(root, name))) {
              const pid = Number(
                await fs.readFile(path.join(root, name), 'utf8')
              );
              if (pid > 1) {
                try {
                  process.kill(-pid, 'SIGKILL');
                } catch {
                  /* exited */
                }
              }
            }
          }
          await result;
          if (oldTmp === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = oldTmp;
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    );

    test('exact compiled source main scrubs invalid activation in the same process', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'p70-main-'));
      const main = path.join(root, 'main.cjs');
      const observer = path.join(root, 'observer.cjs');
      const snapshot = path.join(root, 'snapshot.json');
      try {
        const options = {
          bundle: true,
          platform: 'node' as const,
          target: 'node24',
          external: ['tree-sitter', 'tree-sitter-*', 'esbuild'],
        };
        buildSync({
          ...options,
          entryPoints: [path.resolve('src/main.ts')],
          outfile: main,
        });
        buildSync({ ...options, entryPoints: [__filename], outfile: observer });
        const result = await promisify(execFile)(
          process.execPath,
          [observer, '--source-main', main, snapshot],
          {
            cwd: root,
            timeout: 10_000,
            killSignal: 'SIGKILL',
            env: {
              PATH: process.env.PATH,
              NODE_PATH: path.resolve('node_modules'),
            },
          }
        ).then(
          () => ({ code: 0, stdout: '' }),
          (error: { code: number; stdout: string }) => error
        );
        expect(result.code).toBe(1);
        expect(result.stdout).toContain('review_action_v2_mode_invalid');
        expect(JSON.parse(await fs.readFile(snapshot, 'utf8'))).toEqual({
          remaining: [],
          exitCode: 1,
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
}
