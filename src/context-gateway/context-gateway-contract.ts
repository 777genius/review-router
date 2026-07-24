import { createHash, createHmac } from 'crypto';

export const CONTEXT_GATEWAY_MANIFEST_VERSION = 2 as const;
export const CONTEXT_GATEWAY_POLICY_VERSION = 'context-gateway-v2' as const;
export const CONTEXT_GATEWAY_MAX_OPERATIONS = 2_000;

export type ContextDependencyKind =
  | 'file_read'
  | 'directory_list'
  | 'text_search'
  | 'git_fact';

export type ContextDependencyEntry = Readonly<{
  sequence: number;
  previousEventHash: string;
  eventHash: string;
  operationKey: string;
  operation: Readonly<Record<string, unknown>> & {
    readonly kind: ContextDependencyKind;
  };
  result: Readonly<Record<string, unknown>> & {
    readonly kind: ContextDependencyKind;
    readonly complete: boolean;
    readonly truncated: boolean;
  };
}>;

export type ContextGatewayTranscript = Readonly<{
  transcriptVersion: 1;
  sessionId: string;
  gatewayPolicyVersion: typeof CONTEXT_GATEWAY_POLICY_VERSION;
  gatewayBinaryHash: string;
  checkoutTreeOid: string;
  eventChainSeedHash: string;
  authenticatedChainHash: string;
  dependencies: readonly ContextDependencyEntry[];
  hadFailure: boolean;
  updatedAtMs: number;
}>;

export type ContextGatewayReplayMaterial = Readonly<{
  replayMaterialVersion: 1;
  sessionId: string;
  entries: readonly Readonly<{
    replayHandle: string;
    operationKey: string;
    kind: 'text_search';
    query: string;
  }>[];
}>;

export function canonicalJson(value: unknown): string {
  if (value === undefined) return '{"$undefined":true}';
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('context_gateway_non_finite_number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('context_gateway_canonical_value_invalid');
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function keyedSha256(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function requireSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

export function requireGitOid(value: string, field: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}
