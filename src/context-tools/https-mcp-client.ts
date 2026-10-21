import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { TLSSocket } from 'node:tls';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  approvedEndpoint,
  ContextToolsServer,
  contextToolsError,
} from './contract';

/** Conservative public-unicast policy, including transition/documentation ranges. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 0 || b === 168 || b === 2 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6 || address.includes('.')) return false;
  // Only global unicast 2000::/3; exclude IETF special/transition and documentation ranges.
  const first = parseInt(address.split(':')[0], 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !/^2001:(?:0*[0-1]?[0-9a-f]{1,2}:|0*db8:)/i.test(address) &&
    !/^2002:/i.test(address) &&
    !/^3fff:/i.test(address)
  );
}

/** Node HTTPS owns DNS and sockets: no proxy env, redirects, OAuth or default fetch dial. */
export function createPinnedHttpsFetch(input: {
  endpoint: string;
  responseBytes: number;
  timeoutMs: number;
}): typeof fetch {
  const endpoint = approvedEndpoint(input.endpoint);
  return async (resource, init) => {
    const url = new URL(
      resource instanceof Request ? resource.url : String(resource)
    );
    if (url.href !== endpoint.href)
      throw contextToolsError('destination_changed');
    const began = Date.now();
    const addresses = isIP(url.hostname)
      ? [{ address: url.hostname, family: isIP(url.hostname) }]
      : await boundedLookup(url.hostname, input.timeoutMs);
    if (
      !addresses.length ||
      addresses.some((item) => !isPublicAddress(item.address))
    )
      throw contextToolsError('address_forbidden');
    const address = addresses[0];
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== 'string')
      throw contextToolsError('request_invalid');
    if (
      typeof body === 'string' &&
      Buffer.byteLength(body) > input.responseBytes
    )
      throw contextToolsError('request_too_large');
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const fail = (code: string): void => {
        if (!settled) {
          settled = true;
          reject(contextToolsError(code));
        }
      };
      const req = request(
        url,
        {
          method: init?.method ?? 'GET',
          headers,
          agent: false,
        autoSelectFamily: false,
          servername: isIP(url.hostname) ? undefined : url.hostname,
          rejectUnauthorized: true,
          lookup: (_hostname, _options, callback) =>
            callback(null, address.address, address.family),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            fail('redirect_forbidden');
            return;
          }
          if (status === 401 || status === 403) {
            res.destroy();
            fail('remote_auth_unavailable');
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > input.responseBytes) {
              res.destroy();
              fail('response_too_large');
            } else chunks.push(chunk);
          });
          res.on('error', () => fail('response_failed'));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            const responseHeaders = new Headers();
            for (const name of [
              'content-type',
              'mcp-session-id',
              'mcp-protocol-version',
            ]) {
              const value = res.headers[name];
              if (typeof value === 'string' && value.length <= 1024)
                responseHeaders.set(name, value);
            }
            resolve(
              new Response(
                status === 204 || status === 304 ? null : Buffer.concat(chunks),
                { status, headers: responseHeaders }
              )
            );
          });
        }
      );
      const deadline = setTimeout(
        () => {
          fail('deadline');
          req.destroy();
        },
        Math.max(1, input.timeoutMs - (Date.now() - began))
      );
      deadline.unref();
      const abort = (): void => {
        fail('aborted');
        req.destroy();
      };
      init?.signal?.addEventListener('abort', abort, { once: true });
      req.on('socket', (socket) => {
        (socket as TLSSocket).once('secureConnect', () => {
          const actual = socket.remoteAddress?.replace(/^::ffff:/, '');
          if (!actual || actual !== address.address) {
            fail('destination_changed');
            req.destroy();
          }
        });
      });
      req.on('error', () => fail('request_failed'));
      req.on('close', () => {
        clearTimeout(deadline);
        init?.signal?.removeEventListener('abort', abort);
      });
      if (init?.signal?.aborted) {
        abort();
        return;
      }
      req.end(body);
    });
  };
}

export type RemoteContextTools = Readonly<{
  tools: readonly Tool[];
  call: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<CallToolResult>;
  close: () => Promise<void>;
}>;
export async function connectHttpsContextTools(input: {
  server: ContextToolsServer;
  headers: Readonly<Record<string, string>>;
  responseBytes: number;
  timeoutMs: number;
}): Promise<RemoteContextTools> {
  const client = new Client(
    { name: 'reviewrouter-context', version: '1' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(
    approvedEndpoint(input.server.url),
    {
      requestInit: { headers: input.headers },
      fetch: createPinnedHttpsFetch({
        endpoint: input.server.url,
        responseBytes: input.responseBytes,
        timeoutMs: input.timeoutMs,
      }),
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    }
  );
  try {
    await client.connect(transport, { timeout: input.timeoutMs });
    const discovery = await client.listTools({}, { timeout: input.timeoutMs });
    if (
      discovery.nextCursor ||
      discovery.tools.length > 100 ||
      Buffer.byteLength(JSON.stringify(discovery)) > input.responseBytes
    )
      throw contextToolsError('discovery_invalid');
    const tools = input.server.tools.map((name) => {
      const matches = discovery.tools.filter((tool) => tool.name === name);
      if (
        matches.length !== 1 ||
        Buffer.byteLength(JSON.stringify(matches[0].inputSchema)) > 65536 ||
        (matches[0].description?.length ?? 0) > 8192
      )
        throw contextToolsError('tool_unavailable');
      // Explicit selection is authority; remote readOnlyHint is never treated as permission.
      return matches[0];
    });
    return {
      tools,
      call: async (name, args) => {
        if (!input.server.tools.includes(name))
          throw contextToolsError('tool_forbidden');
        const result = await client.callTool(
          { name, arguments: args },
          undefined,
          { timeout: input.timeoutMs }
        );
        if (Buffer.byteLength(JSON.stringify(result)) > input.responseBytes)
          throw contextToolsError('response_too_large');
        return result as CallToolResult;
      },
      close: () => client.close(),
    };
  } catch {
    await client.close().catch(() => undefined);
    throw contextToolsError('remote_unavailable');
  }
}

async function boundedLookup(
  hostname: string,
  timeoutMs: number
): Promise<{ address: string; family: number }[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(contextToolsError('deadline')),
          timeoutMs
        );
      }),
    ]);
  } catch {
    throw contextToolsError('dns_failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
