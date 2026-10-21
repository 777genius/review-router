export const PR_DESCRIPTION_START_MARKER =
  '<!-- review-router-summary:start -->';
export const PR_DESCRIPTION_END_MARKER = '<!-- review-router-summary:end -->';
const ownedMarkerPairs = [
  [PR_DESCRIPTION_START_MARKER, PR_DESCRIPTION_END_MARKER],
  [
    '<!-- ai-robot-review-summary:start -->',
    '<!-- ai-robot-review-summary:end -->',
  ],
] as const;

export function hasOwnedPrDescriptionMarker(value: string): boolean {
  return /<!--\s*(?:review-router-summary|ai-robot-review-summary):/u.test(
    value
  );
}

/** Remove only complete owned blocks; bytes outside the markers remain intact. */
export function stripOwnedPrDescriptionBlocks(body: string): string {
  let result = body;
  for (const [startMarker, endMarker] of ownedMarkerPairs) {
    let start = result.indexOf(startMarker);
    while (start !== -1) {
      const end = result.indexOf(endMarker, start + startMarker.length);
      if (end === -1) break;
      result = result.slice(0, start) + result.slice(end + endMarker.length);
      start = result.indexOf(startMarker);
    }
  }
  return result;
}
