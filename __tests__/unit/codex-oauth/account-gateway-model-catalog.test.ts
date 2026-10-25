import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { prepareAccountGatewayModelCatalog } from '../../../src/codex-oauth/account-gateway-mimo-catalog';
import pinnedModel from '../../../src/codex-oauth/gpt-5.6-sol-model-0.147.0.json';

describe('account gateway model catalog', () => {
  it('bounds direct Kimi to ordinary Responses function tools and no reasoning/service tier defaults', async () => {
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), 'direct-kimi-catalog-')
    );
    try {
      expect(
        await prepareAccountGatewayModelCatalog('k3-256k', home, [])
      ).toBeUndefined();
      const setting = await prepareAccountGatewayModelCatalog(
        'k3-256k',
        home,
        ['model_provider="kimi"'],
        true
      );
      expect(setting).toContain('model_catalog_json=');
      const catalog: unknown = JSON.parse(
        await fs.readFile(
          path.join(home, 'reviewrouter-model-catalog.json'),
          'utf8'
        )
      );
      expect(catalog).toMatchObject({
        models: [
          {
            slug: 'k3-256k',
            use_responses_lite: false,
            tool_mode: 'direct',
            default_reasoning_level: null,
            supported_reasoning_levels: [],
            supports_reasoning_summary_parameter: false,
            service_tiers: [],
            default_service_tier: null,
            apply_patch_tool_type: null,
            model_messages: null,
          },
        ],
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  it('exposes direct MCP for the pinned GPT model without changing its instructions or other metadata', async () => {
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gateway-gpt-catalog-')
    );
    try {
      const configuration = ['model_provider="reviewrouter_account_gateway"'];
      const setting = await prepareAccountGatewayModelCatalog(
        'gpt-5.6-sol',
        home,
        configuration
      );
      const catalogPath = path.join(home, 'reviewrouter-model-catalog.json');
      const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
      expect(catalog).toEqual({
        models: [
          { ...pinnedModel, tool_mode: 'direct', supports_search_tool: false },
        ],
      });
      // Freeze the complete upstream entry independently of its runtime overlay.
      expect(
        createHash('sha256').update(JSON.stringify(pinnedModel)).digest('hex')
      ).toBe(
        '86010c970bbf300dd61bac68f48afd8dc80f541cc5455e56587ca0dbc7b1ddc3'
      );
      expect(catalog.models[0].multi_agent_version).toBe('v2');
      expect(pinnedModel.tool_mode).toBe('code_mode_only');
      expect(pinnedModel.supports_search_tool).toBe(true);
      expect(pinnedModel.model_messages.instructions_template).not.toBe('');
      expect(setting).toBe(`model_catalog_json=${JSON.stringify(catalogPath)}`);
      expect(await fs.readFile(path.join(home, 'config.toml'), 'utf8')).toBe(
        [...configuration, setting].join('\n') + '\n'
      );
      expect((await fs.stat(catalogPath)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
