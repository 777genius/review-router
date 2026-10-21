import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  canonicalJson,
  sha256,
} from '../../../src/context-gateway/context-gateway-contract';
import { prepareOcrContextTools } from '../../../src/context-tools/ocr-session';

const capture = (builtinTools = ['github.issue.read']) => {
  const preimage = {
    version: 1,
    builtinTools,
    servers: [],
    limits: {
      startupTimeoutMs: 30000,
      callTimeoutMs: 30000,
      responseBytes: 1048576,
      maxCalls: 128,
    },
  };
  return JSON.stringify({
    ...preimage,
    planDigest: `sha256:${sha256(canonicalJson(preimage))}`,
  });
};
const defaults = {
  apiUrl: 'https://api.reviewrouter.org',
  authorization: () => ({
    authorizationId: 'run',
    authorizationToken: 'run-token',
  }),
  checkoutRoot: '/unused',
  headSha: '1'.repeat(40),
  mergeBaseSha: '2'.repeat(40),
  mask: jest.fn(),
  deadlineMs: Date.now() + 10000,
};

test('absent plan has no new API or broker effects', async () => {
  const fetchImpl = jest.fn();
  expect(
    await prepareOcrContextTools({ ...defaults, runtimeEnv: {}, fetchImpl })
  ).toBeUndefined();
  expect(fetchImpl).not.toHaveBeenCalled();
});
test('preflights issue entitlement before exposing tools and uses renewed authorization on the scoped read', async () => {
  const json = capture();
  const digest = (JSON.parse(json) as { planDigest: string }).planDigest;
  let token = 'initial-run-token';
  const fetchImpl = jest.fn(async (resource: unknown, init?: RequestInit) => {
    const route = new URL(String(resource)).pathname;
    expect(JSON.parse(init?.body as string)).toEqual({
      authorizationId: 'run',
      planDigest: digest,
      ...(route.endsWith('github-issue') ? { issueNumber: 7 } : {}),
    });
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${token}`
    );
    expect(init?.redirect).toBe('error');
    return new Response(
      JSON.stringify(
        route.endsWith('credentials')
          ? { planDigest: digest, secrets: {} }
          : { number: 7, title: 'Linked issue', body: 'bounded', comments: [] }
      ),
      { headers: { 'content-type': 'application/json' } }
    );
  });
  const broker = await prepareOcrContextTools({
    ...defaults,
    runtimeEnv: { REVIEW_ROUTER_CONTEXT_TOOLS_PLAN_JSON: json },
    authorization: () => ({
      authorizationId: 'run',
      authorizationToken: token,
    }),
    fetchImpl: fetchImpl as typeof fetch,
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  if (!broker) throw new Error('broker missing');
  const client = new Client(
    { name: 'test', version: '1' },
    { capabilities: {} }
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(broker.config.url), {
        requestInit: {
          headers: { Authorization: `Bearer ${broker.config.capability}` },
        },
      })
    );
    token = 'renewed-run-token';
    const result = await client.callTool({
      name: 'rr_github_issue_read',
      arguments: { issueNumber: 7 },
    });
    expect(JSON.stringify(result)).toContain('Linked issue');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await broker.close();
  }
});
test('unavailable installation entitlement prevents broker/model startup without retaining response details', async () => {
  const fetchImpl = jest.fn(
    async () => new Response('SECRET-PROVIDER-BODY', { status: 503 })
  );
  await expect(
    prepareOcrContextTools({
      ...defaults,
      runtimeEnv: { REVIEW_ROUTER_CONTEXT_TOOLS_PLAN_JSON: capture() },
      fetchImpl: fetchImpl as typeof fetch,
    })
  ).rejects.toThrow('context_tools_server_unavailable');
});

test('immutable documentation read denies secret files and redacts a known secret pattern', async () => {
  fs.mkdirSync('tmp', { recursive: true });
  const repo = fs.mkdtempSync(path.resolve('tmp/context-docs-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'iliya',
        GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
        GIT_COMMITTER_NAME: 'iliya',
        GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com',
      },
    }).trim();
  git('init', '-q');
  fs.mkdirSync(path.join(repo, 'docs'));
  const pattern = 'sk-' + 'A'.repeat(20);
  fs.writeFileSync(
    path.join(repo, 'docs', 'read.md'),
    `Admitted documentation ${pattern}`
  );
  fs.writeFileSync(path.join(repo, 'docs', '.env'), 'SYNTHETIC_PRIVATE_FILE');
  fs.writeFileSync(path.join(repo, 'docs', 'large.md'), 'x'.repeat(65537));
  git('add', '.');
  git('commit', '-qm', 'test: documentation fixture');
  const sha = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'advanced-base');
  fs.writeFileSync(path.join(repo, 'advanced.md'), 'advanced target tip');
  git('add', '.');
  git('commit', '-qm', 'test: advanced base');
  const advancedBase = git('rev-parse', 'HEAD');
  git('checkout', '--detach', sha);
  fs.rmSync(
    path.join(
      repo,
      '.git',
      'objects',
      advancedBase.slice(0, 2),
      advancedBase.slice(2)
    )
  );
  expect(() => git('cat-file', '-e', `${advancedBase}^{commit}`)).toThrow();
  fs.writeFileSync(path.join(repo, 'docs', 'read.md'), 'UNCOMMITTED_CONTENT');
  const fetchImpl = jest.fn();
  const broker = await prepareOcrContextTools({
    ...defaults,
    deadlineMs: Date.now() + 10000,
    runtimeEnv: {
      REVIEW_ROUTER_CONTEXT_TOOLS_PLAN_JSON: capture(['repository.docs.read']),
    },
    checkoutRoot: repo,
    headSha: sha,
    mergeBaseSha: sha,
    fetchImpl,
  });
  if (!broker) throw new Error('broker missing');
  const client = new Client(
    { name: 'test', version: '1' },
    { capabilities: {} }
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(broker.config.url), {
        requestInit: {
          headers: { Authorization: `Bearer ${broker.config.capability}` },
        },
      })
    );
    await expect(
      client.callTool({
        name: 'rr_repository_docs_read',
        arguments: { path: 'docs/.env', revision: 'head' },
      })
    ).rejects.toThrow('context_tools_scope_denied');
    await expect(
      client.callTool({
        name: 'rr_repository_docs_read',
        arguments: { path: 'docs/missing.md', revision: 'base' },
      })
    ).rejects.toThrow('context_tools_scope_denied');
    await expect(
      client.callTool({
        name: 'rr_repository_docs_read',
        arguments: { path: 'docs/large.md', revision: 'base' },
      })
    ).rejects.toThrow('context_tools_scope_denied');
    const result = JSON.stringify(
      await client.callTool({
        name: 'rr_repository_docs_read',
        arguments: { path: 'docs/read.md', revision: 'base' },
      })
    );
    expect(result).toContain('Admitted documentation');
    expect(result).toContain('sk-***');
    expect(result).not.toContain(pattern);
    expect(result).not.toContain('UNCOMMITTED_CONTENT');
    expect(broker.receipt().hadFailure).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    fs.renameSync(
      path.join(repo, '.git'),
      path.join(repo, '.git-backend-down')
    );
    await expect(
      client.callTool({
        name: 'rr_repository_docs_read',
        arguments: { path: 'docs/read.md', revision: 'head' },
      })
    ).rejects.toThrow('context_tools_tool_unavailable');
    expect(broker.receipt().hadFailure).toBe(true);
  } finally {
    await client.close();
    await broker.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
