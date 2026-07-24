import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export const CONTEXT_GATEWAY_READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}) satisfies ToolAnnotations;
