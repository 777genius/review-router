import type { FileChange } from '../../types';

export enum FileRiskTier {
  Security = 'security',
  Migration = 'migration',
  Persistence = 'persistence',
  PublicContract = 'public_contract',
  Normal = 'normal',
}

const TIER_ORDER: Readonly<Record<FileRiskTier, number>> = {
  [FileRiskTier.Security]: 0,
  [FileRiskTier.Migration]: 1,
  [FileRiskTier.Persistence]: 2,
  [FileRiskTier.PublicContract]: 3,
  [FileRiskTier.Normal]: 4,
};

const SECURITY_TOKENS = new Set([
  'access',
  'auth',
  'authentication',
  'authorization',
  'authenticator',
  'authn',
  'authz',
  'crypto',
  'cryptography',
  'jwt',
  'oauth',
  'security',
  'session',
  'sessions',
  'token',
  'tokens',
]);

const MIGRATION_TOKENS = new Set([
  'migration',
  'migrations',
  'schema',
  'schemas',
]);

const PERSISTENCE_TOKENS = new Set([
  'database',
  'datastore',
  'db',
  'persistence',
  'persistent',
  'repositories',
  'repository',
  'storage',
]);

const PUBLIC_CONTRACT_TOKENS = new Set([
  'api',
  'apis',
  'contract',
  'contracts',
]);

function pathTokens(filename: string): string[] {
  return filename
    .replace(/([a-z0-9])([A-Z])/g, '$1/$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function includesToken(
  tokens: readonly string[],
  candidates: Set<string>
): boolean {
  return tokens.some((token) => candidates.has(token));
}

function isActionManifest(
  filename: string,
  tokens: readonly string[]
): boolean {
  const basename = filename.split('/').at(-1)?.toLowerCase();
  if (basename === 'action.yml' || basename === 'action.yaml') return true;

  return (
    tokens.includes('manifest') &&
    (tokens.includes('action') || tokens.includes('actions'))
  );
}

export function classifyFileRisk(filename: string): FileRiskTier {
  const tokens = pathTokens(filename);

  if (includesToken(tokens, SECURITY_TOKENS)) return FileRiskTier.Security;
  if (includesToken(tokens, MIGRATION_TOKENS)) return FileRiskTier.Migration;
  if (includesToken(tokens, PERSISTENCE_TOKENS)) {
    return FileRiskTier.Persistence;
  }
  if (
    includesToken(tokens, PUBLIC_CONTRACT_TOKENS) ||
    isActionManifest(filename, tokens)
  ) {
    return FileRiskTier.PublicContract;
  }

  return FileRiskTier.Normal;
}

export function prioritizeFilesByRisk(
  files: readonly FileChange[]
): FileChange[] {
  return files
    .map((file, originalIndex) => ({
      file,
      originalIndex,
      tier: classifyFileRisk(file.filename),
    }))
    .sort((left, right) => {
      const tierDifference = TIER_ORDER[left.tier] - TIER_ORDER[right.tier];
      return tierDifference !== 0
        ? tierDifference
        : left.originalIndex - right.originalIndex;
    })
    .map(({ file }) => file);
}
