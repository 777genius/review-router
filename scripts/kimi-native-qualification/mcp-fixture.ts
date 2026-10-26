import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const receipt = process.argv[2];
  if (!receipt) throw new Error('fixture_receipt_path_required');
  for await (const line of createInterface({ input: process.stdin })) {
    const message: unknown = JSON.parse(line);
    if (!record(message) || message.id === undefined) continue;
    let result: unknown = {};
    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'reviewrouter-native-qualification', version: '1' },
      };
    } else if (message.method === 'tools/list') {
      result = {
        tools: [
          {
            name: 'read_fixture',
            description: 'Read the public synthetic qualification fixture.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    } else if (message.method === 'tools/call') {
      if (!record(message.params) || message.params.name !== 'read_fixture')
        throw new Error('unexpected_native_tool');
      await appendFile(receipt, 'read_fixture\n', { mode: 0o600 });
      result = {
        content: [{ type: 'text', text: 'KIMI_NATIVE_FIXTURE_READ' }],
        isError: false,
      };
    }
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'
    );
  }
}

void main().catch(() => {
  process.stderr.write('native_mcp_fixture_failed\n');
  process.exitCode = 1;
});
