/** Trusted model-client routing, shared by Codex exec and app-server. */
export const CODEX_OPENROUTER_CONFIGURATION = Object.freeze([
  'model_provider="openrouter"',
  'model_providers.openrouter.name="openrouter"',
  'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
  'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
] as const);
