/** Real pinned OCR native engine + deterministic loopback Responses model.
 * No live subscriptions or hosted Gateway. Actual LLM quality is not tested. */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LocalGitSnapshotReader } from '../../../src/local-review/git-snapshot';
import { runLocalReview } from '../../../src/local-review/run-local-review';
import { NativeOcrEngine, runNativeProcess, type NativeProcessRunner } from '../../../src/local-review/native-ocr';

const binary = process.env.REVIEWROUTER_OCR_BINARY;
const available = Boolean(binary && path.isAbsolute(binary) && existsSync(binary));
if (process.env.REVIEWROUTER_OCR_REQUIRED === '1' && !available) {
  throw new Error('Required native OCR executable is unavailable.');
}

(available ? describe : describe.skip)('real pinned OCR local review through loopback model', () => {
  it('reviews a commit with complete manifest and no source writes', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'reviewrouter-ocr-loopback-'));
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const invocations: string[] = [];
    const diagnostics: string[] = [];
    const abort = new AbortController();
    let server: Server | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      mkdirSync(path.join(repo, 'src'), { recursive: true });
      mkdirSync(path.join(home, '.opencodereview'), { recursive: true });
      const git = (...args: string[]): string => execFileSync('git', args, {
        cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      git('init', '-q');
      git('config', 'user.name', 'OCR Test');
      git('config', 'user.email', 'test@example.invalid');
      const source = path.join(repo, 'src', 'example.go');
      writeFileSync(source, 'package example\nfunc Value() int { return 1 }\n');
      git('add', '.'); git('commit', '-qm', 'base');
      writeFileSync(source, 'package example\nfunc Value() int { return 2 }\n');
      git('add', '.'); git('commit', '-qm', 'head');

      server = createServer((request, response) => {
        invocations.push(`${request.method} ${request.url} ${request.headers.authorization ?? ''}`);
        const id = invocations.length;
        request.resume();
        request.once('end', () => {
          // This custom Responses provider uses non-streaming Responses.New;
          // return a complete JSON Response, not an SSE terminal event.
          const item = { type: 'function_call', id: `fc_${id}`,
            call_id: `call_${id}`, name: 'task_done',
            arguments: '{"state":"DONE"}', status: 'completed' };
          const completed = {
            id: `resp_${id}`, object: 'response', status: 'completed',
            model: 'stub-model', output: [item],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          };
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(completed));
        });
      });
      const activeServer = server;
      const port = await new Promise<number>((resolve, reject) => {
        activeServer.once('error', reject);
        activeServer.listen(0, '127.0.0.1', () => {
          const addr = activeServer.address();
          if (addr && typeof addr !== 'string') resolve(addr.port);
          else reject(new Error('Invalid ephemeral loopback address'));
        });
      });
      writeFileSync(path.join(home, '.opencodereview', 'config.json'), JSON.stringify({
        provider: 'fixture',
        custom_providers: {
          fixture: { protocol: 'openai-responses', url: `http://127.0.0.1:${port}`,
            api_key: 'local-fixture-only', model: 'stub-model', timeout_sec: 15 },
        },
        telemetry: { enabled: false }, effort: 'low',
      }));
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      delete process.env.XDG_CONFIG_HOME;
      const runner: NativeProcessRunner = async (command, args, options) => {
        const output = await runNativeProcess(command, args, options);
        diagnostics.push(`${args[0]} exit=${output.exitCode}: ${output.stderr.slice(0, 500)}`);
        return output;
      };
      watchdog = setTimeout(() => abort.abort(), 60_000);
      const outcome = await runLocalReview({
        engine: 'ocr', scope: { kind: 'commit', ref: 'HEAD' },
        includeUntracked: false, preview: false, provider: 'fixture',
        model: 'stub-model', signal: abort.signal,
      }, {
        git: new LocalGitSnapshotReader(repo),
        ocr: new NativeOcrEngine(runner),
      });
      expect(outcome.status).toBe('complete');
      expect(outcome.coverage.complete).toBe(true);
      expect(outcome.coverage.selectedPaths).toEqual(['src/example.go']);
      expect(outcome.provider.model).toBe('stub-model');
      expect(outcome.findings).toEqual([]);
      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.every(value => value === 'POST /responses Bearer local-fixture-only')).toBe(true);
      expect(git('status', '--porcelain')).toBe('');
    } catch (error) {
      throw new Error(`Real OCR loopback E2E: ${(error as Error).message}; requests=${invocations.length}; ${diagnostics.join(' | ')}`);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      abort.abort();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      if (server) {
        server.closeAllConnections();
        await new Promise<void>(resolve => server!.close(() => resolve()));
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
