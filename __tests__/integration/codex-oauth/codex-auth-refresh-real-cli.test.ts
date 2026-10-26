/** Real pinned Codex, synthetic local OAuth server, no inference or real credentials.
 * REVIEWROUTER_CODEX_AUTH_ISOLATE=1 selects a minimal bwrap filesystem fixture;
 * it never changes host config. Required CI sets REVIEWROUTER_CODEX_AUTH_REQUIRED=1. */
import { createHash } from 'crypto';
import { createServer } from 'http';
import { createReadStream, existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { refreshCodexAuthWithOfficialCli } from '../../../src/codex-oauth/codex-bootstrap';

const binary = process.env.REVIEWROUTER_CODEX_AUTH_BINARY;
const available = binary !== undefined && existsSync(binary);
if (!available && process.env.REVIEWROUTER_CODEX_AUTH_REQUIRED === '1')
  throw new Error('required_pinned_codex_auth_binary_unavailable');
const qualified = available ? describe : describe.skip;
const PINNED_SHA256 =
  'cb0a15567e9a60a5820d54b0f6ae86d504dc3805c1eab21a47f70e3eb7b73a40';

function jwt(claims: Record<string, unknown>): string {
  return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic-signature`;
}

qualified('pinned official Codex auth-only executable', () => {
  it('refreshes synthetic OAuth, writes rotated auth, and never creates a model turn', async () => {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(binary!)) digest.update(chunk);
    expect(digest.digest('hex')).toBe(PINNED_SHA256);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-real-auth-'));
    const originalHome = process.env.HOME;
    process.env.HOME = directory;
    const now = Math.floor(Date.now() / 1000);
    const idToken = jwt({
      iss: 'https://auth.openai.com',
      sub: 'synthetic-user',
      email: 'fixture@example.invalid',
      exp: now + 86400,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'synthetic-account',
        chatgpt_plan_type: 'plus',
      },
    });
    const auth = JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: '2000-01-01T00:00:00Z',
      tokens: {
        id_token: idToken,
        access_token: jwt({ exp: now - 300 }),
        refresh_token: 'synthetic-before',
        account_id: 'synthetic-account',
      },
    });
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: jwt({ exp: now + 86400 }),
            id_token: idToken,
            refresh_token: `synthetic-after-${requests.length}`,
            token_type: 'Bearer',
            expires_in: 86400,
          })
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('fixture_address_invalid');
    let executable = binary!;
    if (process.env.REVIEWROUTER_CODEX_AUTH_ISOLATE === '1') {
      executable = path.join(directory, 'isolated-codex');
      await fs.writeFile(
        executable,
        `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.dirname(process.env.CODEX_HOME);
const result=spawnSync('/usr/bin/bwrap',['--unshare-user','--die-with-parent','--ro-bind',${JSON.stringify(binary)},'/bin/codex','--ro-bind','/proc','/proc','--bind',root,root,'--dir','/etc','--dir','/tmp','--dev-bind','/dev/null','/dev/null','--chdir',process.cwd(),'/bin/codex',...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,PATH:'/bin',HTTPS_PROXY:'http://127.0.0.1:1',NO_PROXY:'127.0.0.1'}});
process.exit(result.status??1);
`,
        { mode: 0o700 }
      );
    }
    try {
      const result = await refreshCodexAuthWithOfficialCli({
        authJsonBytes: auth,
        codexBinaryPath: executable,
        timeoutMs: 15_000,
        requiredValidUntil: Date.now() + 60_000,
        refreshTokenUrlForTest: `http://127.0.0.1:${address.port}/oauth/token`,
      });
      expect(result.accountId).toBe('synthetic-account');
      expect(JSON.parse(result.authJsonBytes).tokens.refresh_token).toMatch(
        /^synthetic-after-/
      );
      expect(result.credentialValidUntil).toBeGreaterThan(Date.now() + 60_000);
      expect(requests.length).toBeGreaterThan(0);
      expect(new Set(requests)).toEqual(new Set(['POST /oauth/token']));
      await result.clearAuthMaterial();
      expect(
        await fs.readdir(path.join(directory, '.reviewrouter', 'runtime'))
      ).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
