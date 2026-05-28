export type GitHubRepositoryPublicKey = {
  keyId: string;
  key: string;
};

export async function fetchGitHubRepositoryPublicKey(input: {
  owner: string;
  repo: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubRepositoryPublicKey> {
  assertSafeOwnerRepoPart(input.owner, 'owner');
  assertSafeOwnerRepoPart(input.repo, 'repo');
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `https://api.github.com/repos/${input.owner}/${input.repo}/actions/secrets/public-key`,
    {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${input.token}`,
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`codex_oauth_public_key_fetch_failed:${response.status}`);
  }
  if (!isPublicKeyResponse(payload)) {
    throw new Error('codex_oauth_public_key_invalid_response');
  }
  return { keyId: payload.key_id, key: payload.key };
}

function isPublicKeyResponse(value: unknown): value is {
  key_id: string;
  key: string;
} {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { key_id?: unknown }).key_id === 'string' &&
    typeof (value as { key?: unknown }).key === 'string' &&
    (value as { key_id: string }).key_id.length > 0 &&
    (value as { key: string }).key.length > 0
  );
}

function assertSafeOwnerRepoPart(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`codex_oauth_invalid_repository_${label}`);
  }
}
