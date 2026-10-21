import dns from 'node:dns/promises';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createPinnedHttpsFetch,
  isPublicAddress,
} from '../../../src/context-tools/https-mcp-client';

const endpoint = 'https://docs.example.com/mcp';
const fetchRemote = () =>
  createPinnedHttpsFetch({ endpoint, responseBytes: 1024, timeoutMs: 2000 });

describe('pinned HTTPS MCP transport', () => {
  afterEach(() => jest.restoreAllMocks());
  test.each([
    '127.0.0.1',
    '10.2.3.4',
    '169.254.169.254',
    '100.100.100.200',
    '192.168.1.1',
    '172.17.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::ffff:8.8.8.8',
    'fe80::1',
    'fc00::1',
    '2001:db8::1',
    '2002:0808:0808::1',
  ])('rejects special/reserved and transition destination %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  test('rejects mixed public/private DNS answers before any socket or secret header dispatch', async () => {
    jest.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '::1', family: 6 },
    ] as never);
    const dial = jest.spyOn(https, 'request');
    await expect(
      fetchRemote()(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer PRIVATE' },
        body: '{}',
      })
    ).rejects.toThrow('context_tools_address_forbidden');
    expect(dial).not.toHaveBeenCalled();
  });
  test('pins the validated address at lookup, disables pooled/default proxy routing, rejects redirects without replay', async () => {
    jest
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    const request = jest.spyOn(https, 'request').mockImplementation(((
      _url: unknown,
      options: https.RequestOptions,
      response: (res: unknown) => void
    ) => {
      expect(options.agent).toBe(false);
      expect(options.servername).toBe('docs.example.com');
      expect(options.rejectUnauthorized).toBe(true);
      const lookup = options.lookup as (
        hostname: string,
        options: unknown,
        callback: (err: unknown, address: string, family: number) => void
      ) => void;
      lookup('docs.example.com', {}, (error, address, family) => {
        expect(error).toBeNull();
        expect(address).toBe('8.8.8.8');
        expect(family).toBe(4);
      });
      const req = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: () => void;
      };
      req.destroy = () => {
        req.emit('close');
      };
      req.end = () => {
        const res = new PassThrough() as PassThrough & {
          statusCode: number;
          headers: Record<string, string>;
        };
        res.statusCode = 302;
        res.headers = { location: 'https://metadata.invalid/steal' };
        response(res);
        req.emit('close');
      };
      return req;
    }) as typeof https.request);
    await expect(
      fetchRemote()(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer PRIVATE' },
        body: '{}',
      })
    ).rejects.toThrow('context_tools_redirect_forbidden');
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('preserves certificate checks and rejects a socket reaching a different address even with trusted TLS', async () => {
    fs.mkdirSync(path.resolve('tmp'), { recursive: true });
    const scratch = fs.mkdtempSync(path.resolve('tmp/mcp-tls-'));
    const keyPath = path.join(scratch, 'key.pem');
    const certPath = path.join(scratch, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=docs.example.com',
        '-addext',
        'subjectAltName=DNS:docs.example.com',
      ],
      { stdio: 'ignore' }
    );
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    const server = https.createServer({ key, cert }, (_req, res) => {
      res.end('{}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('test listener failed');
    const original = https.request;
    jest
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    let trust = false;
    jest.spyOn(https, 'request').mockImplementation(((
      url: URL,
      options: https.RequestOptions,
      callback: (res: IncomingMessage) => void
    ) =>
      original(
        url,
        {
          ...options,
          hostname: '127.0.0.1',
          port: address.port,
          lookup: undefined,
          ...(trust ? { ca: cert } : {}),
        },
        callback
      )) as unknown as typeof https.request);
    try {
      await expect(
        fetchRemote()(endpoint, { method: 'POST', body: '{}' })
      ).rejects.toThrow('context_tools_request_failed');
      trust = true;
      await expect(
        fetchRemote()(endpoint, { method: 'POST', body: '{}' })
      ).rejects.toThrow('context_tools_destination_changed');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
