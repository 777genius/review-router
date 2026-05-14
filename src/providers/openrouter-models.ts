/**
 * OpenRouter free model configuration.
 * Prefer concrete free models that support tool calling so lifecycle
 * revalidation can use a structured submit_review tool call instead of
 * relying on loose text JSON from the free meta-router.
 */

import { logger } from '../utils/logger';

export const PREFERRED_OPENROUTER_FREE_MODELS = [
  'openrouter/inclusionai/ring-2.6-1t:free',
  'openrouter/openai/gpt-oss-120b:free',
  'openrouter/poolside/laguna-m.1:free',
] as const;

/**
 * Get preferred OpenRouter free models.
 * Each model gets a stable instance suffix so the aggregator can treat
 * providers as distinct quorum voters.
 */
export async function getBestFreeModels(
  count = 4,
  _timeoutMs = 5000
): Promise<string[]> {
  logger.debug(`Selecting ${count} preferred OpenRouter free model instances`);

  const models: string[] = [];
  for (let i = 0; models.length < count; i += 1) {
    const model = PREFERRED_OPENROUTER_FREE_MODELS[
      i % PREFERRED_OPENROUTER_FREE_MODELS.length
    ];
    models.push(`${model}#${i + 1}`);
  }
  return models;
}

/**
 * Cache for model list (valid for 1 hour).
 */
let modelCache: { models: string[]; timestamp: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get best free models with caching
 */
export async function getBestFreeModelsCached(
  count = 4,
  timeoutMs = 5000
): Promise<string[]> {
  const now = Date.now();

  // Check cache and return up to requested count
  if (modelCache && now - modelCache.timestamp < CACHE_TTL_MS) {
    logger.debug('Using cached OpenRouter model list');
    // Return up to count models from cache (may have more or fewer cached)
    return modelCache.models.slice(0, count);
  }

  // Get models
  const models = await getBestFreeModels(count, timeoutMs);

  // Update cache
  modelCache = {
    models,
    timestamp: now,
  };

  return models;
}
