import {
  ContextToolsPlan,
  ContextToolsServer,
  contextToolsError,
  logicalNamePattern,
  record,
  contextToolsContract,
} from './contract';

/** Parent-only closure. No values, secret hashes or header values are exposed in receipts. */
export function bindContextToolCredentials(input: {
  plan: ContextToolsPlan;
  githubJson?: string;
  dashboardSecrets?: Readonly<Record<string, string>>;
  mask: (value: string) => void;
}): Readonly<{
  headersFor: (server: ContextToolsServer) => Readonly<Record<string, string>>;
  redact: (value: unknown) => unknown;
}> {
  const expected = { github: new Set<string>(), dashboard: new Set<string>() };
  for (const server of input.plan.servers)
    for (const [name, binding] of Object.entries(server.credentials)) {
      expected[binding.source === 'github-secret' ? 'github' : 'dashboard'].add(
        name
      );
    }
  let github: unknown = {};
  try {
    if (
      input.githubJson &&
      Buffer.byteLength(input.githubJson) >
        contextToolsContract.maxCredentialMapBytes
    )
      throw new Error();
    github = input.githubJson ? JSON.parse(input.githubJson) : {};
  } catch {
    throw contextToolsError('credentials_invalid');
  }
  const collect = (
    values: unknown,
    selected: Set<string>
  ): Map<string, string> => {
    if (
      !record(values) ||
      Buffer.byteLength(JSON.stringify(values)) >
        contextToolsContract.maxCredentialMapBytes ||
      Object.keys(values).some((key) => !selected.has(key))
    )
      throw contextToolsError('credentials_invalid');
    const result = new Map<string, string>();
    for (const name of selected) {
      const value = values[name];
      if (
        !logicalNamePattern.test(name) ||
        typeof value !== 'string' ||
        !value.trim() ||
        Buffer.byteLength(value) > contextToolsContract.maxCredentialBytes ||
        /[\r\n\0]/.test(value)
      )
        throw contextToolsError('credentials_unavailable');
      input.mask(value);
      result.set(name, value);
    }
    return result;
  };
  const gh = collect(github, expected.github);
  const dashboard = collect(input.dashboardSecrets ?? {}, expected.dashboard);
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      for (const secret of [...gh.values(), ...dashboard.values()])
        value = (value as string).split(secret).join('[REDACTED]');
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (record(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          redact(key),
          redact(child),
        ])
      );
    return value;
  };
  const headersFor = (
    server: ContextToolsServer
  ): Readonly<Record<string, string>> => {
    const headers: Record<string, string> = {};
    for (const [header, template] of Object.entries(server.headers)) {
      const unresolved = template.replace(
        /\$?\{\{\s*secrets\.([A-Z][A-Z0-9_]{0,63})\s*\}\}/g,
        ''
      );
      if (/[{}]|\$\(/.test(unresolved))
        throw contextToolsError('template_invalid');
      const value = template.replace(
        /\$?\{\{\s*secrets\.([A-Z][A-Z0-9_]{0,63})\s*\}\}/g,
        (_match, name: string) => {
          const binding = server.credentials[name];
          const secret =
            binding &&
            (binding.source === 'github-secret' ? gh : dashboard).get(name);
          if (!secret) throw contextToolsError('credentials_unavailable');
          return secret;
        }
      );
      if (/[\r\n\0]/.test(value) || Buffer.byteLength(value) > 16384)
        throw contextToolsError('template_invalid');
      headers[header] = value;
    }
    return Object.freeze(headers);
  };
  return { headersFor, redact };
}
