import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CONTEXT_GATEWAY_READ_ONLY_TOOL_ANNOTATIONS } from './context-gateway-tool-annotations';

export const CONTEXT_GATEWAY_TOOL_DEFINITIONS = Object.freeze([
  defineTool({
    name: 'review_read_file',
    description:
      'Read a bounded byte range from one repository file. Read more ranges when eof is false.',
    annotations: CONTEXT_GATEWAY_READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1_024 },
        startByte: { type: 'integer', minimum: 0 },
        maxBytes: {
          type: 'integer',
          minimum: 1,
          maximum: 2 * 1024 * 1024,
        },
      },
    },
  }),
  defineTool({
    name: 'review_list_directory',
    description:
      'List tracked repository paths below a directory with bounded depth and result count.',
    annotations: CONTEXT_GATEWAY_READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1_024 },
        maxDepth: { type: 'integer', minimum: 1, maximum: 32 },
        includeHidden: { type: 'boolean' },
        maxEntries: { type: 'integer', minimum: 1, maximum: 20_000 },
      },
    },
  }),
  defineTool({
    name: 'review_search_text',
    description:
      'Search tracked non-binary repository text. A truncated result makes this review ineligible for reuse.',
    annotations: CONTEXT_GATEWAY_READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 4_096 },
        paths: {
          type: 'array',
          maxItems: 128,
          items: { type: 'string', minLength: 1, maxLength: 1_024 },
        },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 20_000,
        },
        caseSensitive: { type: 'boolean' },
      },
    },
  }),
  defineTool({
    name: 'review_git_fact',
    description:
      'Read one allowlisted Git fact for the authorized pull request revision.',
    annotations: CONTEXT_GATEWAY_READ_ONLY_TOOL_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['fact'],
      properties: {
        fact: {
          type: 'string',
          enum: ['changed_paths', 'diff_stat', 'merge_base'],
        },
      },
    },
  }),
]);

function defineTool(tool: Tool): Tool {
  return tool;
}
