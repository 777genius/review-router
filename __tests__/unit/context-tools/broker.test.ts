import canonicalFixture from '../../../src/control-plane/generated/review-action-v2/fixtures/context-tools-v1.json';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  canonicalJson,
  sha256,
} from '../../../src/context-gateway/context-gateway-contract';
import { startContextToolsBroker } from '../../../src/context-tools/broker';
import {
  parseContextToolsPlan,
  CONTEXT_TOOLS_PROFILE,
} from '../../../src/context-tools/contract';
import { bindContextToolCredentials } from '../../../src/context-tools/credential-bindings';
import * as httpsMcp from '../../../src/context-tools/https-mcp-client';

function plan(servers: unknown[] = []) {
  const preimage = {
    version: 1,
    builtinTools: ['repository.docs.read'],
    servers,
    limits: {
      startupTimeoutMs: 30000,
      callTimeoutMs: 30000,
      responseBytes: 1048576,
      maxCalls: 128,
    },
  };
  return parseContextToolsPlan(
    JSON.stringify({
      ...preimage,
      planDigest: `sha256:${sha256(canonicalJson(preimage))}`,
    })
  );
}
const remote = {
  id: 'docs',
  version: 1,
  url: 'https://docs.example.com/mcp',
  tools: ['read'],
  headers: {
    Authorization: 'Bearer {{ secrets.TOKEN }}',
    'X-Token': '${{ secrets.TOKEN }}',
  },
  credentials: { TOKEN: { source: 'github-secret', name: 'DOCS_TOKEN' } },
};

describe('captured context tool credential boundary', () => {
  test('consumes the canonical generated fixture and exact qualified descriptor', () => {
    expect(parseContextToolsPlan(JSON.stringify(canonicalFixture))).toEqual(
      canonicalFixture
    );
    expect(CONTEXT_TOOLS_PROFILE).toEqual({
      extensionId: 'context-tools.v1',
      descriptorDigest:
        'sha256:c188ad0a29581317f23b6aec3f103a7419f67576bea6fb3dc9910cf9ca3a3f7a',
    });
  });
  test('substitutes only explicit logical keys, masks values, and redacts nested quoted secret echoes', () => {
    const selected = plan([remote]);
    const value = 'test-"{token}"';
    const mask = jest.fn();
    const bindings = bindContextToolCredentials({
      plan: selected,
      githubJson: JSON.stringify({ TOKEN: value }),
      mask,
    });
    expect(bindings.headersFor(selected.servers[0])).toEqual({
      Authorization: `Bearer ${value}`,
      'X-Token': value,
    });
    expect(mask).toHaveBeenCalledWith(value);
    expect(bindings.redact({ content: [{ text: `error ${value}` }] })).toEqual({
      content: [{ text: 'error [REDACTED]' }],
    });
  });
  test.each([
    undefined,
    '{}',
    '{"TOKEN":""}',
    '{"TOKEN":"x\\r\\nInjected: y"}',
    '{"TOKEN":"valid","UNSELECTED":"secret"}',
    JSON.stringify({ TOKEN: '💡'.repeat(2049) }),
  ])(
    'fails missing, empty, oversized, injection or unsolicited credentials before connection',
    (githubJson) => {
      expect(() =>
        bindContextToolCredentials({
          plan: plan([remote]),
          githubJson,
          mask: jest.fn(),
        })
      ).toThrow(/^context_tools_credentials_/);
    }
  );
  test('rejects mismatched capture digest and ambiguous cross-connection secret authority', () => {
    expect(() =>
      parseContextToolsPlan(
        JSON.stringify({ ...plan(), planDigest: `sha256:${'0'.repeat(64)}` })
      )
    ).toThrow('context_tools_plan_digest_invalid');
    expect(() =>
      plan([
        remote,
        {
          ...remote,
          id: 'other',
          credentials: {
            TOKEN: {
              source: 'dashboard-secret',
              credentialRef: 'cred',
              version: 1,
            },
          },
        },
      ])
    ).toThrow('context_tools_binding_ambiguous');
  });
});

describe('SDK 1.29 stateless loopback broker interop', () => {
  test('initializes, lists and calls across fresh request transports, deduplicates concurrent reads and closes', async () => {
    const call = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { content: [{ type: 'text' as const, text: 'immutable-doc' }] };
    });
    const broker = await startContextToolsBroker({
      plan: plan(),
      mask: jest.fn(),
      deadlineMs: Date.now() + 10000,
      builtins: {
        'repository.docs.read': {
          definition: {
            name: 'docs',
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
          validateArguments: (args) =>
            Object.keys(args).length === 1 && typeof args.path === 'string',
          call,
        },
      },
    });
    const client = new Client(
      { name: 'native-compatible-test', version: '1' },
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
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ['rr_repository_docs_read']
      );
      const results = await Promise.all(
        [1, 2].map(() =>
          client.callTool({
            name: 'rr_repository_docs_read',
            arguments: { path: 'docs/a.md' },
          })
        )
      );
      expect(results[0]).toEqual(results[1]);
      expect(call).toHaveBeenCalledTimes(1);
      expect(broker.receipt()).toMatchObject({
        nativeConnected: true,
        calls: 1,
        hadFailure: false,
        toolCalls: [
          {
            toolName: 'rr_repository_docs_read',
            started: 1,
            succeeded: 1,
            failed: 0,
          },
        ],
      });
      await expect(
        client.callTool({
          name: 'rr_repository_docs_read',
          arguments: { path: 'docs/a.md', inject: true },
        })
      ).rejects.toThrow('context_tools_arguments_invalid');
      expect(call).toHaveBeenCalledTimes(1);
      expect(broker.receipt().toolCalls).toEqual([
        {
          toolName: 'rr_repository_docs_read',
          started: 1,
          succeeded: 1,
          failed: 0,
        },
      ]);
      const denied = await fetch(broker.config.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${broker.config.capability}`,
          origin: 'https://attacker.example',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(denied.status).toBe(403);
      expect((await fetch(broker.config.url, { method: 'POST' })).status).toBe(
        403
      );
    } finally {
      await client.close();
      await broker.close();
    }
    await expect(fetch(broker.config.url)).rejects.toThrow();
  });
  test('keeps a read capability available after a query-domain isError and treats 2020 schemas only as metadata', async () => {
    const call = jest.fn(async (args: Record<string, unknown>) =>
      args.query === 'bad'
        ? {
            isError: true,
            content: [{ type: 'text' as const, text: 'query not found' }],
          }
        : {
            content: [
              { type: 'text' as const, text: 'corrected query result' },
            ],
          }
    );
    const broker = await startContextToolsBroker({
      plan: plan(),
      mask: jest.fn(),
      deadlineMs: Date.now() + 10000,
      builtins: {
        'repository.docs.read': {
          definition: {
            name: 'query',
            inputSchema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              properties: { query: { type: 'string', pattern: '(a+)+$' } },
            },
          },
          call,
        },
      },
    });
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
      expect(
        (
          await client.callTool({
            name: 'rr_repository_docs_read',
            arguments: { query: 'bad' },
          })
        ).isError
      ).toBe(true);
      expect(
        (
          await client.callTool({
            name: 'rr_repository_docs_read',
            arguments: { query: 'corrected!' },
          })
        ).isError
      ).toBeUndefined();
      expect(call).toHaveBeenCalledTimes(2);
      expect(broker.receipt()).toMatchObject({ calls: 2, hadFailure: false });
      expect(broker.receipt().toolCalls).toEqual([
        {
          toolName: 'rr_repository_docs_read',
          started: 2,
          succeeded: 1,
          failed: 1,
        },
      ]);
    } finally {
      await client.close();
      await broker.close();
    }
  });
  test('caches unknown delivery failures and honestly refuses absent selected builtin tools', async () => {
    await expect(
      startContextToolsBroker({
        plan: plan(),
        mask: jest.fn(),
        deadlineMs: Date.now() + 1000,
        builtins: {},
      })
    ).rejects.toThrow('context_tools_selected_tools_unavailable');
    const call = jest.fn(async () => {
      throw new Error('SECRET-PROVIDER-BODY');
    });
    const broker = await startContextToolsBroker({
      plan: plan(),
      mask: jest.fn(),
      deadlineMs: Date.now() + 10000,
      builtins: {
        'repository.docs.read': {
          definition: { name: 'docs', inputSchema: { type: 'object' } },
          call,
        },
      },
    });
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
      for (const unused of [1, 2]) {
        void unused;
        await expect(
          client.callTool({ name: 'rr_repository_docs_read', arguments: {} })
        ).rejects.toThrow('context_tools_tool_unavailable');
      }
      expect(call).toHaveBeenCalledTimes(1);
      expect(broker.receipt()).toMatchObject({ calls: 1, hadFailure: true });
      expect(broker.receipt().toolCalls).toEqual([
        {
          toolName: 'rr_repository_docs_read',
          started: 1,
          succeeded: 0,
          failed: 1,
        },
      ]);
      expect(JSON.stringify(broker.receipt())).not.toContain('SECRET');
    } finally {
      await client.close();
      await broker.close();
    }
  });

  test('reports actual successes separately for three selected tools without arguments or credentials', async () => {
    const secret = 'SYNTHETIC-SECRET-CANARY';
    const marker = 'PRIVATE-QUERY-CANARY';
    const names = ['search', 'scrape', 'fixture'];
    const call = jest.fn(async () => ({
      content: [{ type: 'text' as const, text: secret }],
    }));
    const connect = jest
      .spyOn(httpsMcp, 'connectHttpsContextTools')
      .mockResolvedValue({
        tools: names.map((name) => ({
          name,
          inputSchema: { type: 'object' as const },
        })),
        call,
        close: jest.fn(async () => undefined),
      });
    const broker = await startContextToolsBroker({
      plan: plan([{ ...remote, tools: names }]),
      githubJson: JSON.stringify({ TOKEN: secret }),
      builtins: {
        'repository.docs.read': {
          definition: { name: 'docs', inputSchema: { type: 'object' } },
          call,
        },
      },
      mask: jest.fn(),
      deadlineMs: Date.now() + 10000,
    });
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
      for (const name of names) {
        const request = {
          name: `rr_mcp_docs_${name}`,
          arguments: { query: marker },
        };
        await client.callTool(request);
        await client.callTool(request);
      }
      await expect(
        client.callTool({ name: marker, arguments: {} })
      ).rejects.toThrow('context_tools_arguments_invalid');
      expect(call).toHaveBeenCalledTimes(3);
      expect(broker.receipt().toolCalls).toEqual([
        {
          toolName: 'rr_repository_docs_read',
          started: 0,
          succeeded: 0,
          failed: 0,
        },
        ...names.map((name) => ({
          toolName: `rr_mcp_docs_${name}`,
          started: 1,
          succeeded: 1,
          failed: 0,
        })),
      ]);
      const receipt = JSON.stringify(broker.receipt());
      for (const forbidden of [
        secret,
        marker,
        broker.config.capability,
        remote.url,
        'Authorization',
        'arguments',
      ]) {
        expect(receipt).not.toContain(forbidden);
      }
      // A caller cannot mutate future accounting by editing an earlier receipt.
      (broker.receipt().toolCalls[1] as { succeeded: number }).succeeded = 99;
      expect(broker.receipt().toolCalls[1].succeeded).toBe(1);
    } finally {
      await client.close();
      await broker.close();
      connect.mockRestore();
    }
  });
});
