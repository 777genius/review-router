import { CONTEXT_GATEWAY_READ_ONLY_TOOL_ANNOTATIONS } from '../../../src/context-gateway/context-gateway-tool-annotations';
import { CONTEXT_GATEWAY_TOOL_DEFINITIONS } from '../../../src/context-gateway/context-gateway-tool-definitions';

describe('context gateway tool annotations', () => {
  it('declares every confined tool as read-only and closed-world', () => {
    expect(CONTEXT_GATEWAY_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'review_read_file',
      'review_list_directory',
      'review_search_text',
      'review_git_fact',
    ]);
    expect(
      CONTEXT_GATEWAY_TOOL_DEFINITIONS.every(
        (tool) =>
          tool.annotations === CONTEXT_GATEWAY_READ_ONLY_TOOL_ANNOTATIONS
      )
    ).toBe(true);
    expect(CONTEXT_GATEWAY_TOOL_DEFINITIONS[0]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});
