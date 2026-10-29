import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import sodium from 'libsodium-wrappers';
import { refreshCodexAuthWithOfficialCli } from '../../../src/codex-oauth/codex-bootstrap';
import { readPreparedCodexCredential } from '../../../src/codex-oauth/codex-auth-refresh-validation';
import { encryptCodexAuthForGitHubSecret } from '../../../src/codex-oauth/crypto';

function jwt(claims: Record<string, unknown>): string {
  return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic-signature`;
}
function auth(): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    last_refresh: '2000-01-01T00:00:00Z',
    tokens: {
      id_token: jwt({
        iss: 'https://auth.openai.com',
        sub: 'synthetic-user',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'synthetic-account',
        },
      }),
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) - 300 }),
      refresh_token: 'synthetic-refresh-before',
      account_id: 'synthetic-account',
    },
  });
}

describe('official auth-only app-server bootstrap protocol', () => {
  let directory: string;
  let originalHome: string | undefined;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-auth-refresh-'));
    originalHome = process.env.HOME;
    process.env.HOME = directory;
  });
  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function executable(mode = 'success'): Promise<string> {
    const binary = path.join(directory, 'codex-fixture');
    await fs.writeFile(
      binary,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const mode = ${JSON.stringify(mode)};
const records = ${JSON.stringify(path.join(directory, 'requests.jsonl'))};
fs.writeFileSync(${JSON.stringify(path.join(directory, 'child.pid'))}, String(process.pid));
if (process.argv.slice(2).join(' ') !== 'app-server') process.exit(41);
const reply = value => process.stdout.write(JSON.stringify(value) + '\\n');
const jwt = value => Buffer.from('{"alg":"RS256"}').toString('base64url') + '.' + Buffer.from(JSON.stringify(value)).toString('base64url') + '.synthetic-signature';
readline.createInterface({input:process.stdin}).on('line', line => {
 const message = JSON.parse(line);
 fs.appendFileSync(records, JSON.stringify(message) + '\\n');
 if (message.method === 'initialize') return reply({id:1,result:{userAgent:'fixture'}});
 if (message.method === 'initialized') return;
 if (message.method !== 'account/read' || message.params.refreshToken !== true) process.exit(42);
 if (mode === 'hang') return;
 if (mode === 'malformed') return process.stdout.write('not json\\n');
 if (mode === 'overflow') return process.stdout.write('x'.repeat(1024*1024+1));
 const filename = path.join(process.env.CODEX_HOME,'auth.json');
 const auth = JSON.parse(fs.readFileSync(filename,'utf8'));
 if (mode !== 'unchanged') {
  auth.tokens.access_token = jwt({exp:Math.floor(Date.now()/1000)+(mode === 'short' ? 30 : mode === 'expired' ? -30 : 7200)});
  auth.tokens.refresh_token = 'synthetic-refresh-after';
  auth.last_refresh = new Date().toISOString();
  if (mode === 'changed-account') {
   auth.tokens.id_token = jwt({iss:'https://auth.openai.com',sub:'other','https://api.openai.com/auth':{chatgpt_account_id:'other'}});
   auth.tokens.account_id = 'other';
  }
  fs.writeFileSync(filename,JSON.stringify(auth));
 }
 reply({id:2,result:{account:{type:'chatgpt'},requiresOpenaiAuth:true}});
});
`,
      { mode: 0o700 }
    );
    return binary;
  }

  async function remainingHomes(): Promise<string[]> {
    return fs
      .readdir(path.join(directory, '.reviewrouter', 'runtime'))
      .catch(() => []);
  }

  it('forces refresh without a thread/turn, preserves identity, returns lifetime, and removes private material', async () => {
    const requiredValidUntil = Date.now() + 3_600_000;
    const result = await refreshCodexAuthWithOfficialCli({
      authJsonBytes: auth(),
      codexBinaryPath: await executable(),
      requiredValidUntil,
    });
    expect(result.accountId).toBe('synthetic-account');
    expect(result.credentialValidUntil).toBeGreaterThan(
      requiredValidUntil + 60_000
    );
    expect(JSON.parse(result.authJsonBytes).tokens.refresh_token).toBe(
      'synthetic-refresh-after'
    );
    const prepared = readPreparedCodexCredential(
      result.authJsonBytes,
      requiredValidUntil
    );
    expect(prepared).toEqual({
      accessToken: JSON.parse(result.authJsonBytes).tokens.access_token,
      accountId: result.accountId,
      credentialValidUntil: result.credentialValidUntil,
    });
    expect(prepared).not.toHaveProperty('refreshToken');
    expect(prepared).not.toHaveProperty('authJsonBytes');
    const requests = (
      await fs.readFile(path.join(directory, 'requests.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(requests.map((request) => request.method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
    ]);
    expect(requests[2].params).toEqual({ refreshToken: true });
    expect(
      (await fs.stat(path.join(result.codexHome, 'auth.json'))).mode & 0o777
    ).toBe(0o600);
    await result.clearAuthMaterial();
    await result.clearAuthMaterial();
    expect(await remainingHomes()).toEqual([]);
  });

  it.each(['short', 'expired'])(
    'preserves a confirmed %s rotation through the existing sealed writeback format but refuses inference',
    async (mode) => {
      const deadline = Date.now() + 60_000;
      const result = await refreshCodexAuthWithOfficialCli({
        authJsonBytes: auth(),
        codexBinaryPath: await executable(mode),
        requiredValidUntil: deadline,
      });
      try {
        await sodium.ready;
        const keys = sodium.crypto_box_keypair();
        const sealed = await encryptCodexAuthForGitHubSecret({
          authJsonBytes: result.authJsonBytes,
          githubPublicKeyBase64: Buffer.from(keys.publicKey).toString('base64'),
          githubKeyId: 'synthetic-writeback-key',
          generationHashSalt: Buffer.alloc(32, 1).toString('base64url'),
        });
        const preserved = Buffer.from(
          sodium.crypto_box_seal_open(
            Buffer.from(sealed.encryptedValue, 'base64'),
            keys.publicKey,
            keys.privateKey
          )
        ).toString('utf8');
        expect(JSON.parse(preserved).tokens.refresh_token).toBe(
          'synthetic-refresh-after'
        );
        expect(result.credentialValidUntil).toBeLessThan(deadline + 60_000);
        expect(() => readPreparedCodexCredential(preserved, deadline)).toThrow(
          'codex_oauth_refresh_lifetime_insufficient'
        );
        const requests = (
          await fs.readFile(path.join(directory, 'requests.jsonl'), 'utf8')
        ).trim().split('\n').map((line) => JSON.parse(line).method);
        expect(requests).toEqual(['initialize', 'initialized', 'account/read']);
      } finally {
        await result.clearAuthMaterial();
      }
      expect(await remainingHomes()).toEqual([]);
    }
  );

  it('rechecks lifetime and account consistency without invoking another helper process', () => {
    const original = JSON.parse(auth());
    expect(() =>
      readPreparedCodexCredential(JSON.stringify(original), Date.now() + 60_000)
    ).toThrow('codex_oauth_refresh_lifetime_insufficient');
    original.tokens.access_token = 'opaque-fixture-token';
    expect(() =>
      readPreparedCodexCredential(JSON.stringify(original), Date.now() + 60_000)
    ).toThrow('codex_oauth_refresh_expiry_unavailable');
    original.tokens.account_id = 'different-account';
    expect(() =>
      readPreparedCodexCredential(JSON.stringify(original), Date.now() + 60_000)
    ).toThrow('codex_oauth_refresh_account_mismatch');
  });

  it.each([
    ['unchanged', 'codex_oauth_refresh_not_confirmed'],
    ['changed-account', 'codex_oauth_refresh_account_changed'],
    ['malformed', 'codex_oauth_refresh_protocol_invalid'],
    ['overflow', 'codex_oauth_refresh_output_bound'],
  ])('rejects %s and cleans auth before rejecting', async (mode, failure) => {
    await expect(
      refreshCodexAuthWithOfficialCli({
        authJsonBytes: auth(),
        codexBinaryPath: await executable(mode),
        requiredValidUntil: Date.now() + 60_000,
      })
    ).rejects.toThrow(failure);
    expect(await remainingHomes()).toEqual([]);
  });

  it('kills the process group on timeout, cleans auth, and never replays account/read', async () => {
    await expect(
      refreshCodexAuthWithOfficialCli({
        authJsonBytes: auth(),
        codexBinaryPath: await executable('hang'),
        timeoutMs: 250,
      })
    ).rejects.toThrow('codex_oauth_refresh_timeout');
    expect(await remainingHomes()).toEqual([]);
    const childPid = Number(
      await fs.readFile(path.join(directory, 'child.pid'), 'utf8')
    );
    expect(() => process.kill(childPid, 0)).toThrow();
    const requests = await fs.readFile(
      path.join(directory, 'requests.jsonl'),
      'utf8'
    );
    expect(requests.match(/account\/read/g)).toHaveLength(1);
  });

  it('honors cancellation without exposing child diagnostics or retaining auth', async () => {
    const controller = new AbortController();
    const binary = await executable('hang');
    const run = refreshCodexAuthWithOfficialCli({
      authJsonBytes: auth(),
      codexBinaryPath: binary,
      signal: controller.signal,
    });
    const rejection = expect(run).rejects.toThrow(
      'codex_oauth_refresh_cancelled'
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await fs.stat(path.join(directory, 'child.pid')).then(
          () => true,
          () => false
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await rejection;
    expect(await remainingHomes()).toEqual([]);
  });

  it('cleans auth after an executable startup failure', async () => {
    await expect(
      refreshCodexAuthWithOfficialCli({
        authJsonBytes: auth(),
        codexBinaryPath: path.join(directory, 'missing'),
      })
    ).rejects.toThrow('codex_oauth_refresh_spawn_failed');
    expect(await remainingHomes()).toEqual([]);
  });

  it('rejects a non-loopback fixture URL before materializing credentials', async () => {
    await expect(
      refreshCodexAuthWithOfficialCli({
        authJsonBytes: auth(),
        refreshTokenUrlForTest: 'https://example.invalid/refresh',
      })
    ).rejects.toThrow('codex_oauth_refresh_fixture_url_invalid');
    expect(await remainingHomes()).toEqual([]);
  });
});
