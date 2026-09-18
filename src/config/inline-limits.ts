export const DEFAULT_INLINE_MAX_COMMENTS = 50;
const LEGACY_DEFAULT_INLINE_MAX_COMMENTS = 5;

/**
 * The old product default of 5 was a presentation cap, not an operator choice.
 * Treat that legacy value as "post every finding up to the safety cap".
 * 0 still disables inline comments.
 */
export function effectiveInlineMaxComments(value: number): number {
  if (value === 0) {
    return 0;
  }
  if (value === LEGACY_DEFAULT_INLINE_MAX_COMMENTS) {
    return DEFAULT_INLINE_MAX_COMMENTS;
  }
  return value;
}
