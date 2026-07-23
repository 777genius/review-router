export enum ProviderKind {
  CodexCli = 'codex_cli',
  ClaudeCodeCli = 'claude_code_cli',
  GeminiCli = 'gemini_cli',
  OpenCodeCli = 'opencode_cli',
  OpenRouterHttp = 'openrouter_http',
}

export const PROVIDER_EXECUTION_CONTRACT_VERSION =
  'review-provider-prepared-invocation.v1' as const;

export type ProviderCredentialLease = {
  readonly bearerToken?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
};

export type PreparedProviderInvocation<
  Request extends object = Readonly<Record<string, unknown>>,
> = {
  readonly contractVersion: typeof PROVIDER_EXECUTION_CONTRACT_VERSION;
  readonly providerKind: ProviderKind;
  readonly providerName: string;
  readonly requestedModel: string;
  readonly timeoutMs: number;
  readonly request: DeepReadonly<Request>;
  /**
   * Canonical provider-observable input. It is an in-memory handoff to the
   * manifest assembler and must not be logged or persisted because it may
   * contain review context.
   */
  readonly observableInputPreimage: string;
};

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export function createPreparedProviderInvocation<
  Request extends object,
>(input: {
  readonly providerKind: ProviderKind;
  readonly providerName: string;
  readonly requestedModel: string;
  readonly timeoutMs: number;
  readonly request: Request;
}): PreparedProviderInvocation<Request> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('provider_invocation_timeout_invalid');
  }

  const request = cloneAndFreeze(input.request);
  const envelope = {
    contractVersion: PROVIDER_EXECUTION_CONTRACT_VERSION,
    providerKind: input.providerKind,
    providerName: input.providerName,
    requestedModel: input.requestedModel,
    timeoutMs: input.timeoutMs,
    request,
  };

  return Object.freeze({
    ...envelope,
    observableInputPreimage: canonicalize(envelope),
  });
}

export function requirePreparedProviderInvocation<Request extends object>(
  invocation: PreparedProviderInvocation,
  providerKind: ProviderKind,
  providerName: string
): PreparedProviderInvocation<Request> {
  if (
    invocation.contractVersion !== PROVIDER_EXECUTION_CONTRACT_VERSION ||
    invocation.providerKind !== providerKind ||
    invocation.providerName !== providerName
  ) {
    throw new Error('provider_prepared_invocation_mismatch');
  }
  return invocation as PreparedProviderInvocation<Request>;
}

export function snapshotCredentialEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze({ ...environment });
}

export function describeEnvironmentContract(
  environment: NodeJS.ProcessEnv
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(environment)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [
          key,
          isCredentialEnvironmentKey(key) ? '<credential>' : value,
        ])
    )
  );
}

export function splitProviderEnvironment(environment: NodeJS.ProcessEnv): {
  readonly runtimeEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly credentialEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly contract: Readonly<Record<string, string>>;
} {
  const runtimeEnvironment: NodeJS.ProcessEnv = {};
  const credentialEnvironment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (isCredentialEnvironmentKey(key)) credentialEnvironment[key] = value;
    else runtimeEnvironment[key] = value;
  }
  return Object.freeze({
    runtimeEnvironment: Object.freeze(runtimeEnvironment),
    credentialEnvironment: Object.freeze(credentialEnvironment),
    contract: describeEnvironmentContract(environment),
  });
}

export function mergeCredentialEnvironment(
  runtimeEnvironment: Readonly<NodeJS.ProcessEnv>,
  credentialEnvironment?: Readonly<NodeJS.ProcessEnv>
): Readonly<NodeJS.ProcessEnv> {
  const merged: NodeJS.ProcessEnv = { ...runtimeEnvironment };
  for (const [key, value] of Object.entries(credentialEnvironment ?? {})) {
    if (!isCredentialEnvironmentKey(key)) {
      throw new Error('provider_credential_lease_contains_runtime_config');
    }
    if (value !== undefined) merged[key] = value;
  }
  return Object.freeze(merged);
}

function isCredentialEnvironmentKey(key: string): boolean {
  return /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/i.test(key);
}

function cloneAndFreeze<T>(value: T): DeepReadonly<T> {
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item) => cloneAndFreeze(item))
    ) as DeepReadonly<T>;
  }
  if (isPlainObject(value)) {
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      clone[key] = cloneAndFreeze(item);
    }
    return Object.freeze(clone) as DeepReadonly<T>;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value as DeepReadonly<T>;
  }
  throw new Error('provider_invocation_request_value_invalid');
}

function canonicalize(value: unknown): string {
  if (value === undefined) return '{"$undefined":true}';
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('provider_invocation_request_number_invalid');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  throw new Error('provider_invocation_request_value_invalid');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
