import sodium from 'libsodium-wrappers';
import {
  runCodexOAuthRotatingRuntime,
  CodexOAuthRuntimePorts,
} from '../../../src/codex-oauth/runtime';

describe('Codex OAuth rotating runtime', () => {
  const authJsonBytes = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { refresh_token: 'refresh-token-secret' },
    last_refresh: '2026-05-25T00:00:00.000Z',
  });
  const refreshedAuthJsonBytes = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { refresh_token: 'refreshed-token-secret' },
    last_refresh: '2026-05-25T01:00:00.000Z',
  });
  const salt = Buffer.from('runtime-generation-hash-salt-32').toString(
    'base64url'
  );

  let publicKey: string;
  let logSpy: jest.SpyInstance;

  beforeAll(async () => {
    await sodium.ready;
    publicKey = Buffer.from(sodium.crypto_box_keypair().publicKey).toString(
      'base64'
    );
  });

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env['INPUT_AUTH-JSON'] = authJsonBytes;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'oidc-request-token';
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL =
      'https://token.actions.githubusercontent.com';
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env['INPUT_AUTH-JSON'];
    delete process.env.INPUT_AUTH_JSON;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.CODEX_HOME;
  });

  it('runs prelease before auth read, writeback before checkout, and comments after auth clear', async () => {
    const events: string[] = [];
    const ports = buildPorts(events);

    const result = await runCodexOAuthRotatingRuntime(
      {
        apiUrl: 'https://api.reviewrouter.site',
        audience: 'reviewrouter',
        providerInstanceId: 'codex-rotating:123456',
        workflowSchemaVersion: 1,
        repository: '777genius/agent-teams-ai',
        headSha: '0123456789abcdef0123456789abcdef01234567',
        workspacePath: '/tmp/workspace',
      },
      ports
    );

    expect(result.status).toBe('completed');
    expect(events).toEqual([
      'oidc',
      'prelease',
      'clear-oidc-env',
      'prepare-codex',
      'finalize',
      'public-key',
      'writeback-preflight',
      'refresh',
      'writeback',
      'checkout-token',
      'checkout',
      'review',
      'clear-auth-material',
      'clear-process-auth-env',
      'comment-token',
      'comment',
    ]);
    expect(process.env['INPUT_AUTH-JSON']).toBeUndefined();
  });

  it('skips stale queued secrets without refreshing, checkout, or comments', async () => {
    const events: string[] = [];
    const ports = buildPorts(events);
    ports.controlPlane.finalize = jest.fn(async () => {
      events.push('finalize');
      return {
        protocolVersion: 1 as const,
        leaseId: 'lease:12345678',
        nextGeneration: 2,
        status: 'stale_queued_secret' as const,
      };
    });

    const result = await runCodexOAuthRotatingRuntime(
      {
        apiUrl: 'https://api.reviewrouter.site',
        audience: 'reviewrouter',
        providerInstanceId: 'codex-rotating:123456',
        workflowSchemaVersion: 1,
        repository: '777genius/agent-teams-ai',
        headSha: '0123456789abcdef0123456789abcdef01234567',
        workspacePath: '/tmp/workspace',
      },
      ports
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: 'stale_queued_secret',
    });
    expect(events).toEqual([
      'oidc',
      'prelease',
      'clear-oidc-env',
      'prepare-codex',
      'finalize',
      'clear-process-auth-env',
    ]);
  });

  function buildPorts(events: string[]): CodexOAuthRuntimePorts {
    return {
      oidc: {
        requestToken: jest.fn(async () => {
          events.push('oidc');
          return 'oidc.jwt';
        }),
      },
      controlPlane: {
        prelease: jest.fn(async () => {
          events.push('prelease');
          expect(process.env['INPUT_AUTH-JSON']).toBe(authJsonBytes);
          return {
            protocolVersion: 1 as const,
            leaseId: 'lease:12345678',
            providerInstanceId: 'codex-rotating:123456',
            repository: '777genius/agent-teams-ai',
            generationHashSalt: salt,
            currentGeneration: 1,
            expiresAt: '2026-05-25T12:00:00.000Z',
          };
        }),
        finalize: jest.fn(async () => {
          events.push('finalize');
          expect(process.env['INPUT_AUTH-JSON']).toBeUndefined();
          return {
            protocolVersion: 1 as const,
            leaseId: 'lease:12345678',
            nextGeneration: 2,
            status: 'finalized' as const,
            repositoryOwner: '777genius',
            repositoryName: 'agent-teams-ai',
            publicKeyReadToken: 'ghs_public_key_read',
            publicKeyReadTokenExpiresAt: '2026-05-25T12:15:00.000Z',
          };
        }),
        writebackPreflight: jest.fn(async () => {
          events.push('writeback-preflight');
          return { protocolVersion: 1 as const, status: 'ready' as const };
        }),
        writeback: jest.fn(async (body) => {
          events.push('writeback');
          expect(JSON.stringify(body)).not.toContain('refreshed-token-secret');
          return { protocolVersion: 1 as const, status: 'accepted' as const };
        }),
        checkoutToken: jest.fn(async () => {
          events.push('checkout-token');
          return {
            protocolVersion: 1 as const,
            token: 'ghs_checkout',
            expiresAt: '2026-05-25T12:15:00.000Z',
            repository: '777genius/agent-teams-ai',
            permissions: {
              contents: 'read' as const,
              pullRequests: 'read' as const,
            },
          };
        }),
        commentToken: jest.fn(async () => {
          events.push('comment-token');
          expect(events).toContain('clear-auth-material');
          return {
            protocolVersion: 1 as const,
            token: 'ghs_comment',
            expiresAt: '2026-05-25T12:15:00.000Z',
            repository: '777genius/agent-teams-ai',
            permissions: {
              contents: 'read' as const,
              pullRequests: 'write' as const,
              issues: 'write' as const,
            },
          };
        }),
      },
      githubSecrets: {
        fetchPublicKey: jest.fn(async () => {
          events.push('public-key');
          return { keyId: 'github-key-id', key: publicKey };
        }),
      },
      codex: {
        prepareCli: jest.fn(async () => {
          events.push('prepare-codex');
          expect(process.env['INPUT_AUTH-JSON']).toBe(authJsonBytes);
          return { binaryPath: '/tmp/codex-bin' };
        }),
        refreshAuth: jest.fn(async (input) => {
          events.push('refresh');
          expect(input.codexBinaryPath).toBe('/tmp/codex-bin');
          return {
            authJsonBytes: refreshedAuthJsonBytes,
            codexHome: '/tmp/codex-home',
            async clearAuthMaterial() {
              events.push('clear-auth-material');
            },
          };
        }),
      },
      checkout: {
        checkoutExactHead: jest.fn(async () => {
          events.push('checkout');
          expect(events).toContain('writeback');
        }),
      },
      review: {
        run: jest.fn(async () => {
          events.push('review');
          return { skipped: false, markdown: 'summary' };
        }),
      },
      comments: {
        post: jest.fn(async () => {
          events.push('comment');
        }),
      },
      lifecycle: {
        clearOidcEnv: () => {
          events.push('clear-oidc-env');
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
          delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
        },
        clearProcessAuthEnv: () => {
          events.push('clear-process-auth-env');
          delete process.env.CODEX_HOME;
        },
      },
    };
  }
});
