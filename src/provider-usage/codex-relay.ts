import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createResponsesUsageObserver } from './responses-observer';
import type { UsageDelivery } from './delivery';

/** Trusted configuration only. Route via supported provider baseURL settings.
 * Authentication remains in the caller: no credential is exported or persisted. */
export async function startCodexUsageRelay(input: {
  upstreamBaseUrl: string;
  model: string;
  delivery: UsageDelivery;
  provider: 'codex' | 'openai' | 'mimo' | 'openrouter' | 'claude';
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  fetchUpstream?: typeof fetch;
}) {
  const target = new URL(input.upstreamBaseUrl);
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error('usage_relay_target_invalid');
  if (
    input.provider === 'claude' &&
    (target.origin !== 'https://api.anthropic.com' || target.pathname !== '/')
  ) {
    throw new Error('usage_relay_target_invalid');
  }
  for (const value of [
    input.maxRequestBytes ?? 16777216,
    input.maxResponseBytes ?? 67108864,
    input.timeoutMs ?? 120000,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 67108864)
      throw new Error('usage_relay_limits_invalid');
  }
  const capability = randomBytes(32).toString('base64url'),
    auth = Buffer.from(capability);
  const active = new Set<AbortController>(),
    flights = new Set<Promise<void>>();
  let closed = false;
  const server = createServer((request, response) => {
    const flight = (async () => {
      // Capability lives only in the private URL path supplied to this child.
      const path = request.url?.split('?')[0] ?? '';
      const prefix = `/${capability}`;
      const supplied = Buffer.from(path.slice(1, 1 + capability.length));
      if (
        closed ||
        supplied.length !== auth.length ||
        !timingSafeEqual(supplied, auth) ||
        !path.startsWith(prefix + '/') ||
        request.method !== 'POST' ||
        request.url?.includes('?')
      ) {
        response.writeHead(404).end();
        return;
      }
      const suffix = path.slice(prefix.length);
      if (
        ![
          '/responses',
          '/chat/completions',
          '/messages',
          '/v1/messages',
          ...(input.provider === 'claude'
            ? ['/messages/count_tokens', '/v1/messages/count_tokens']
            : []),
        ].includes(suffix)
      ) {
        response.writeHead(404).end();
        return;
      }
      if (active.size >= 8) {
        response.writeHead(429).end();
        return;
      }
      const controller = new AbortController();
      active.add(controller);
      const timer = setTimeout(
        () => controller.abort(),
        input.timeoutMs ?? 120000
      );
      timer.unref();
      const disconnect = () => {
        if (!response.writableFinished) controller.abort();
      };
      response.once('close', disconnect);
      let call: ReturnType<typeof createResponsesUsageObserver> | undefined,
        failed = false;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const bytes of request) {
          size += bytes.length;
          if (size > (input.maxRequestBytes ?? 16 * 1024 * 1024)) {
            response.writeHead(413).end();
            return;
          }
          chunks.push(Buffer.from(bytes));
        }
        const body = Buffer.concat(chunks);
        const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown };
        if (
          typeof parsed.model !== 'string' ||
          parsed.model.length < 1 ||
          parsed.model.length > 200 ||
          Array.from(parsed.model).some(
            (character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
          )
        ) {
          response.writeHead(400).end();
          return;
        }
        const headers: Record<string, string> = {
          'content-type': 'application/json',
        };
        const hopByHop = new Set([
          'host',
          'connection',
          'proxy-connection',
          'proxy-authorization',
          'transfer-encoding',
          'content-length',
          'keep-alive',
          'upgrade',
          'te',
          'trailer',
          'accept-encoding',
          ...String(request.headers.connection ?? '')
            .split(',')
            .map((value) => value.trim().toLowerCase()),
        ]);
        for (const [name, value] of Object.entries(request.headers)) {
          if (!hopByHop.has(name) && typeof value === 'string')
            headers[name] = value;
        }
        if (!suffix.endsWith('/count_tokens'))
          call = createResponsesUsageObserver(
            input.delivery,
            input.model,
            input.provider
          );
        await call?.dispatched();
        const upstream = await (input.fetchUpstream ?? fetch)(
          target.href.replace(/\/$/, '') + suffix,
          {
            method: 'POST',
            headers,
            body: body.toString('utf8'),
            signal: controller.signal,
            redirect: 'manual',
          }
        );
        call?.responseReceived();
        failed = !upstream.ok;
        response.writeHead(upstream.status, {
          'content-type':
            upstream.headers.get('content-type') ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        if (!upstream.body) {
          failed = true;
          response.end();
          return;
        }
        const decoder = new TextDecoder(),
          sse = upstream.headers
            .get('content-type')
            ?.includes('text/event-stream');
        let pending = '',
          observedBytes = 0,
          parseEnabled = true;
        const observeJson = (text: string) => {
          try {
            call?.observe(JSON.parse(text));
          } catch {
            /* Malformed/missing usage remains unknown. */
          }
        };
        for await (const bytes of upstream.body) {
          observedBytes += bytes.length;
          if (observedBytes > (input.maxResponseBytes ?? 64 * 1024 * 1024))
            throw new Error('usage_relay_response_limit');
          if (parseEnabled) {
            pending += decoder.decode(bytes, { stream: true });
            if (sse) {
              for (;;) {
                const delimiter = /\r\n\r\n|\n\n|\r\r/.exec(pending);
                if (!delimiter) break;
                const frame = pending.slice(0, delimiter.index);
                pending = pending.slice(delimiter.index + delimiter[0].length);
                const data = frame
                  .split(/\r\n|\n|\r/)
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trimStart())
                  .join('\n');
                if (data !== '[DONE]') observeJson(data);
              }
            }
            // Stop telemetry parsing rather than breaking inference on large frames.
            if (Buffer.byteLength(pending) > 1024 * 1024) {
              pending = '';
              parseEnabled = false;
            }
          }
          if (!response.write(bytes)) {
            const drainAbort = new AbortController();
            try {
              await Promise.race([
                once(response, 'drain', { signal: drainAbort.signal }),
                once(response, 'close', { signal: drainAbort.signal }).then(
                  () => {
                    throw new Error('usage_relay_closed');
                  }
                ),
              ]);
            } finally {
              drainAbort.abort();
            }
          }
        }
        if (parseEnabled && !sse) observeJson(pending + decoder.decode());
        response.end();
      } catch {
        failed = true;
        if (!response.headersSent) response.writeHead(502);
        response.end();
      } finally {
        await call?.finish(failed, controller.signal.aborted);
        clearTimeout(timer);
        active.delete(controller);
        response.off('close', disconnect);
      }
    })();
    flights.add(flight);
    void flight.finally(() => flights.delete(flight));
  });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('usage_relay_listen_failed');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/${capability}`,
    async close() {
      closed = true;
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([...flights]);
    },
  };
}
