/** Credentials belong to the model client, never model-spawned shell tools. */
export const CODEX_SHELL_ENVIRONMENT_POLICY = Object.freeze([
  'shell_environment_policy.ignore_default_excludes=false',
  'shell_environment_policy.filters={OPENAI_API_KEY="exclude",OPENROUTER_API_KEY="exclude",MIMO_TOKEN_PLAN_API_KEY="exclude"}',
] as const);

export const CODEX_CONFINEMENT_DISABLED_FEATURES = Object.freeze([
  'shell_tool',
  'unified_exec',
  'browser_use',
  'computer_use',
  'js_repl',
  'tool_search',
  // Native delegation cannot share the gateway's fenced execution session.
  'multi_agent',
  'multi_agent_v2',
  // Codex 0.145 starts the built-in codex_apps MCP unless this is explicit.
  'apps',
  'plugins',
  // Hooks are stable and default-on in Codex 0.145. Memory surfaces are
  // disabled explicitly so a future/default config cannot add hidden context.
  'hooks',
  'memories',
  'external_agent_memory_import',
  'chronicle',
]);
