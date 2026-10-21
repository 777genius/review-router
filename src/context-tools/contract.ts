import {
  canonicalJson,
  sha256,
} from '../context-gateway/context-gateway-contract';

export type CredentialBinding =
  | Readonly<{ source: 'github-secret'; name: string }>
  | Readonly<{
      source: 'dashboard-secret';
      credentialRef: string;
      version: number;
    }>;
export type ContextToolsServer = Readonly<{
  id: string;
  version: number;
  url: string;
  headers: Readonly<Record<string, string>>;
  tools: readonly string[];
  credentials: Readonly<Record<string, CredentialBinding>>;
}>;
export type ContextToolsPlan = Readonly<{
  version: 1;
  builtinTools: readonly ('github.issue.read' | 'repository.docs.read')[];
  servers: readonly ContextToolsServer[];
  limits: Readonly<{
    startupTimeoutMs: 30000;
    callTimeoutMs: 30000;
    responseBytes: 1048576;
    maxCalls: 128;
  }>;
  planDigest: string;
}>;
export const CONTEXT_TOOLS_CREDENTIALS_ENV =
  'REVIEWROUTER_MCP_CREDENTIALS_JSON';
export const CONTEXT_TOOLS_PLAN_ENV = 'REVIEW_ROUTER_CONTEXT_TOOLS_PLAN_JSON';
export const logicalNamePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
export const toolNamePattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export class ContextToolsError extends Error {
  constructor(readonly code: string) {
    super(`context_tools_${code}`);
  }
}
export function contextToolsError(code: string): ContextToolsError {
  return new ContextToolsError(code);
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === expected.sort().join(',');
}
export function approvedEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw contextToolsError('endpoint_invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.hostname ||
    url.hostname.endsWith('.') ||
    value.length > 2048 ||
    /[{}$]/.test(value)
  )
    throw contextToolsError('endpoint_invalid');
  return url;
}
/** Validate metadata received through the captured runtime configuration, never a PR file. */
export function parseContextToolsPlan(json: string): ContextToolsPlan {
  if (Buffer.byteLength(json) > 131072) throw contextToolsError('plan_invalid');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw contextToolsError('plan_invalid');
  }
  if (
    !record(value) ||
    !keys(value, [
      'version',
      'builtinTools',
      'servers',
      'limits',
      'planDigest',
    ]) ||
    value.version !== 1 ||
    !Array.isArray(value.builtinTools) ||
    value.builtinTools.length > 2 ||
    new Set(value.builtinTools).size !== value.builtinTools.length ||
    value.builtinTools.some(
      (x) => x !== 'github.issue.read' && x !== 'repository.docs.read'
    ) ||
    !Array.isArray(value.servers) ||
    value.servers.length > 4 ||
    !record(value.limits) ||
    !keys(value.limits, [
      'startupTimeoutMs',
      'callTimeoutMs',
      'responseBytes',
      'maxCalls',
    ]) ||
    value.limits.startupTimeoutMs !== 30000 ||
    value.limits.callTimeoutMs !== 30000 ||
    value.limits.responseBytes !== 1048576 ||
    value.limits.maxCalls !== 128 ||
    typeof value.planDigest !== 'string'
  )
    throw contextToolsError('plan_invalid');
  const ids = new Set<string>();
  const bindings = new Map<string, string>();
  for (const server of value.servers) {
    if (
      !record(server) ||
      !keys(server, [
        'id',
        'version',
        'url',
        'headers',
        'tools',
        'credentials',
      ]) ||
      typeof server.id !== 'string' ||
      !/^[a-z][a-z0-9_]{0,31}$/.test(server.id) ||
      ids.has(server.id) ||
      !Number.isSafeInteger(server.version) ||
      Number(server.version) < 1 ||
      typeof server.url !== 'string' ||
      !record(server.headers) ||
      Object.keys(server.headers).length > 16 ||
      !record(server.credentials) ||
      Object.keys(server.credentials).length > 16 ||
      !Array.isArray(server.tools) ||
      server.tools.length < 1 ||
      server.tools.length > 20 ||
      new Set(server.tools).size !== server.tools.length ||
      server.tools.some(
        (x) => typeof x !== 'string' || !toolNamePattern.test(x)
      )
    )
      throw contextToolsError('plan_invalid');
    approvedEndpoint(server.url);
    ids.add(server.id);
    for (const [name, binding] of Object.entries(server.credentials)) {
      if (
        !logicalNamePattern.test(name) ||
        !record(binding) ||
        !(
          (binding.source === 'github-secret' &&
            keys(binding, ['source', 'name']) &&
            typeof binding.name === 'string' &&
            logicalNamePattern.test(binding.name)) ||
          (binding.source === 'dashboard-secret' &&
            keys(binding, ['source', 'credentialRef', 'version']) &&
            typeof binding.credentialRef === 'string' &&
            /^[A-Za-z0-9_-]{1,128}$/.test(binding.credentialRef) &&
            Number.isSafeInteger(binding.version) &&
            Number(binding.version) > 0)
        )
      )
        throw contextToolsError('plan_invalid');
      const identity = canonicalJson(binding);
      if (bindings.has(name) && bindings.get(name) !== identity)
        throw contextToolsError('binding_ambiguous');
      bindings.set(name, identity);
    }
    const referenced = new Set<string>();
    const headerNames = new Set<string>();
    for (const [name, template] of Object.entries(server.headers)) {
      if (
        !/^(Authorization|X-[A-Za-z0-9-]+|CONTEXT7_API_KEY)$/i.test(name) ||
        /^(x-forwarded-|x-real-|x-http-method|x-original-|x-rewrite-|x-host|x-proxy|x-mcp-)/i.test(
          name
        ) ||
        headerNames.has(name.toLowerCase()) ||
        typeof template !== 'string' ||
        !template.length ||
        template.length > 4096 ||
        /[\r\n\0]/.test(template)
      )
        throw contextToolsError('header_invalid');
      headerNames.add(name.toLowerCase());
      const placeholders = [
        ...template.matchAll(
          /\$?\{\{\s*secrets\.([A-Z][A-Z0-9_]{0,63})\s*\}\}/g
        ),
      ];
      if (
        !placeholders.length ||
        /[{}]/.test(
          template.replace(
            /\$?\{\{\s*secrets\.([A-Z][A-Z0-9_]{0,63})\s*\}\}/g,
            ''
          )
        )
      )
        throw contextToolsError('template_invalid');
      for (const placeholder of placeholders) referenced.add(placeholder[1]);
    }
    if (
      [...referenced].sort().join(',') !==
      Object.keys(server.credentials).sort().join(',')
    )
      throw contextToolsError('binding_invalid');
  }
  const { planDigest, ...preimage } = value;
  if (planDigest !== `sha256:${sha256(canonicalJson(preimage))}`)
    throw contextToolsError('plan_digest_invalid');
  return JSON.parse(canonicalJson(value)) as ContextToolsPlan;
}
