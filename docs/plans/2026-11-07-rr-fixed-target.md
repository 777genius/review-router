# PR command: `/rr fixed` — targeted verification

Status: implementation plan accompanying a Draft PR. Source baseline: Action `fcc3e1d6bfd1208a9a36a8b2f6fb018dd1b0cbaf` and SaaS `c0382d6c`.

## Goal and explicit exclusions

Reply `/rr fixed` under **one** ReviewRouter-owned inline finding. Read the *current* PR HEAD and immutable target evidence, run one bounded provider-neutral revalidation using the existing `finding-revalidation` contracts, and post one **read-only** result: `fixed`, `still present`, or `cannot verify`. No implicit `skip`, no resolution, no GitHub approval, no code changes and no blanket full PR review.

## Small design

1. Add an exact parser route for `fixed` and verified bot mention alias. Require a direct inline reply; independently fetch parent finding from GitHub, reject malformed/ambiguous finding markers, bot/outsider, fork PR, stale source/HEAD, unsupported inline location. Never trust paths, hashes or roles from command text.
2. Use the existing captured current SHA, scope, revalidation target witness and immutable source-reader. Reuse `planFindingRevalidation` / `runFindingRevalidation`, accepted verdict schema and confidence/scope thresholds. No new model prompts or "line removed = fixed" heuristic. If qualified provider, exact lifecycle snapshot, quota or evidence is unavailable, return **cannot verify**.
3. Use the existing managed request/session admission + idempotent publication mechanism. Prefer the existing same-repository Gateway-only authority path. Never introduce untrusted branch checkout, provider keys in PR workflows, or fall back to legacy paid inference without replay guarantee.
4. Publish a bounded answer with current SHA, verified evidence and reason; never automatically resolve a GitHub thread. Race after inference/source change => `cannot verify`, not false `fixed`.

## Acceptance / E2E

Exact command and malformed/embedded command; parent marker valid/conflicting, wrong parent, outsider and GitHub role change; fork, old head/line drift, rename/deleted file; truly fixed/still present/ambiguous with cited present source; unknown provider/config/coverage; webhook duplicates and concurrent delivery, edited/deleted event; bounded single target and one inference; no model-induced code or memory write; GitHub PR inline reply and no auto resolve; full CI and release pin qualification. Real on-demand provider invocation must be proven before advertising positive verdicts.

## Budget and boundaries

Target 550–1,100 manually maintained lines (including tests/docs, excluding generated artifacts), subject to actual existing ports. Never implement a new task queue, new provider integration, new DB engine, generic agent framework or migration just for this command. If existing lifecycle invocation cannot run independently from a whole PR review, keep the command explicitly `cannot verify` and split the prerequisite under a separately reviewed scope, never fabricate success.

Review passes: threat/authorization; deterministic target/currentness; failure/replay and UX; tests/release/CI.