import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  canonicalJson,
  sha256,
} from '../../../src/context-gateway/context-gateway-contract';
import { startContextToolsBroker } from '../../../src/context-tools/broker';
import { parseContextToolsPlan } from '../../../src/context-tools/contract';
import { bindContextToolCredentials } from '../../../src/context-tools/credential-bindings';

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
  ])(
    'fails missing, empty, injection or unsolicited credentials before connection: %s',
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
      });
      await expect(
        client.callTool({
          name: 'rr_repository_docs_read',
          arguments: { path: 'docs/a.md', inject: true },
        })
      ).rejects.toThrow('context_tools_arguments_invalid');
      expect(call).toHaveBeenCalledTimes(1);
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
      expect(JSON.stringify(broker.receipt())).not.toContain('SECRET');
    } finally {
      await client.close();
      await broker.close();
    }
  });
});
