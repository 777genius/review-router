import * as fs from 'fs/promises';
import * as path from 'path';

// Private, bounded ModelInfo subset for Codex rust-v0.147.0 / be6e8eac.
// Values: frozen action-mimo-0147-bounded-catalog-input.json (SHA256 b6190be1...).
// Official source: https://example-files.cnbj1.mi-fds.com/example-files/configs/model-catalogs.json
// Source SHA256: 8834dc34d879b8489b7376a5a1788f0d1b696f8410fc2df3544ad38ab145601a.
// Provider instruction templates and unknown vendor fields are deliberately omitted.
type MiMoModelInfo = Readonly<{
  slug: 'mimo-v2.6-pro';
  display_name: string;
  description: string;
  base_instructions: '';
  default_reasoning_level: 'low';
  supported_reasoning_levels: readonly Readonly<{
    effort: 'none' | 'low' | 'medium' | 'high';
    description: string;
  }>[];
  shell_type: 'unified_exec';
  visibility: 'list';
  supported_in_api: boolean;
  priority: number;
  support_verbosity: boolean;
  apply_patch_tool_type: 'freeform';
  truncation_policy: Readonly<{ mode: 'tokens'; limit: number }>;
  supports_parallel_tool_calls: false;
  context_window: number;
  max_context_window: number;
  auto_compact_token_limit: null;
  comp_hash: string;
  default_reasoning_summary: 'none';
  input_modalities: readonly ('text' | 'image')[];
  supports_image_detail_original: boolean;
  experimental_supported_tools: readonly string[];
  use_responses_lite: true;
  tool_mode: 'code_mode_only';
  multi_agent_version: 'v2';
  include_skills_usage_instructions: boolean;
  include_apps_usage_instructions: boolean;
  include_plugin_usage_instructions: boolean;
  auto_review_model_override: null;
  model_specialty: null;
}>;

const mimoModel: MiMoModelInfo = {
  slug: 'mimo-v2.6-pro',
  display_name: 'MiMo-V2.6-Pro',
  description: 'Xiaomi MiMo: MiMo-V2.6-Pro',
  base_instructions: '',
  default_reasoning_level: 'low',
  supported_reasoning_levels: [
    { effort: 'none', description: 'No extra reasoning for faster responses' },
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    {
      effort: 'medium',
      description: 'Balances speed and reasoning depth for everyday tasks',
    },
    {
      effort: 'high',
      description: 'Greater reasoning depth for complex problems',
    },
  ],
  shell_type: 'unified_exec',
  visibility: 'list',
  supported_in_api: true,
  priority: 0,
  support_verbosity: false,
  apply_patch_tool_type: 'freeform',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: false,
  context_window: 1048576,
  max_context_window: 1048576,
  auto_compact_token_limit: null,
  comp_hash: '3000',
  default_reasoning_summary: 'none',
  input_modalities: ['text', 'image'],
  supports_image_detail_original: true,
  experimental_supported_tools: ['send_user_message_async', 'clock'],
  use_responses_lite: true,
  tool_mode: 'code_mode_only',
  multi_agent_version: 'v2',
  include_skills_usage_instructions: false,
  include_apps_usage_instructions: false,
  include_plugin_usage_instructions: false,
  auto_review_model_override: null,
  model_specialty: null,
};

/** Called only by account-gateway preparation after authoritative model selection.
 * The home comes from the runtime-owned transport environment, never a catalog
 * path from checkout, user environment, or provider metadata. */
export async function prepareAccountGatewayModelCatalog(
  model: string,
  codexHome: string | undefined,
  gatewayConfiguration: readonly string[]
): Promise<string | undefined> {
  if (model !== mimoModel.slug) return undefined;
  if (!codexHome || !path.isAbsolute(codexHome))
    throw new Error('account_gateway_catalog_home_unavailable');

  const catalogPath = path.join(codexHome, 'reviewrouter-model-catalog.json');
  const setting = `model_catalog_json=${JSON.stringify(catalogPath)}`;
  await fs.writeFile(
    catalogPath,
    JSON.stringify({ models: [mimoModel] }) + '\n',
    { mode: 0o600 }
  );
  await fs.chmod(catalogPath, 0o600);
  const configPath = path.join(codexHome, 'config.toml');
  // Rebuild owned config instead of appending: repeated preparations in one
  // authorized review have identical bytes and exactly one catalog setting.
  await fs.writeFile(
    configPath,
    [...gatewayConfiguration, setting].join('\n') + '\n',
    { mode: 0o600 }
  );
  await fs.chmod(configPath, 0o600);
  return setting;
}
