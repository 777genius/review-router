import { startCodexUsageRelay } from './codex-relay';
import type { UsageDelivery } from './delivery';

/** Fixed Anthropic origin through the CLI's supported base URL setting. */
export function startAnthropicUsageRelay(
  delivery: UsageDelivery,
  model: string,
  timeoutMs: number
) {
  return startCodexUsageRelay({
    upstreamBaseUrl: 'https://api.anthropic.com',
    model,
    provider: 'claude',
    delivery,
    timeoutMs,
  });
}
