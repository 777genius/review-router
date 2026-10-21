# Review Skills — runtime delivery

Status: draft implementation, paired with [SaaS PR #635](https://github.com/777genius/review-router-ai/pull/635).

The authoritative implementation plan and three-round review log live in the SaaS repository at `ai-docs/plans/2026-10-21-review-skills.md` and `ai-docs/plans/2026-10-21-review-skills-reviews.md`.

## Runtime scope

1. Consume an explicitly versioned, immutable, run-authorized Skills envelope; preserve legacy absent-extension behavior.
2. Resolve explicitly enabled Git Skills and bounded Markdown references from the captured trusted base commit, without sending repository file bodies to the control plane.
3. Feed the same engine-neutral per-path instructions to managed OCR and the native reviewer, including investigation prompts.
4. Correct OCR's generated rules to its actual parser; qualify exact case-sensitive paths and an assigned-file allowlist with the patched real binary.
5. Include Skills in incremental compatibility and invocation identity, preserving historical hash preimages.
6. Verify real OCR requests against loopback Responses, native parity, trusted Git resolution, bounds, capability negotiation, and generated contract parity.

No tests or implementation completeness are claimed at this initial checkpoint. Stable release tags, production pins, and deployment are outside this implementation PR.
