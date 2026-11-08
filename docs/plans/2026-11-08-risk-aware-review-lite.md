# Risk-Aware Review Lite — implementation and E2E plan

**Date:** 2026-11-08  
**Repository:** `777genius/review-router` (GitHub Action)  
**Status:** implementation proposal; draft PR opened before implementation  
**Source of ideas:** independent implementation of general risk-prioritization concepts. **Do not copy, translate, or port LiveReview source, proprietary algorithms, datasets, UI or assets.** Its Sustainable Use License restricts commercial derivative uses.

## 1. Goal and user experience

Help a PR author see **which changes deserve attention first and why**, without requiring a separate dashboard, new settings or additional clicks.

The existing GitHub review remains the single user-visible surface. When supported evidence exists, show a small **"Where to look first"** section with up to three changed files/locations, a plain-language rationale (e.g. "Used by several other parts of this repository") and a direct link pinned to the reviewed commit. When evidence is incomplete, say "Impact could not be assessed" rather than labelling it low risk.

The risk ranking supplements findings and review coverage. It **must not** silently change finding severity, confidence, deduplication, blocking rules, threads, or GitHub publication permissions. No auto-approve, no mandatory second AI call, no model training.

## 2. Scope (hard boundaries)

Included:
1. **Blast Radius Lite**: bounded deterministic signals from changed paths/lines and existing in-memory code-graph/context, only when already available or safely cheap; use existing AST/graph/test utilities rather than a second parser.
2. **Priority ranking**: pure, documented ordering of affected changes using distinct notions of impact, uncertainty and existing finding severity; an unknown signal contributes no positive safety evidence.
3. **GitHub summary**: concise localization-ready plain-language presentation in the existing summary pipeline, with a maximum of three entries and a full-coverage/partial-coverage explanation.
4. **TDD + E2E**: fixtures, unit/integration tests, security/performance boundaries, production Action bundle parity and GitHub workflow evidence.

Explicit exclusions:
- No ML/scoring service, database schema, network fetch, feature flag, new CLI or API, UI dashboard, background job, git hook, provider change or GitLab adapter.
- No reading arbitrary repository files in untrusted context, executing PR code, enabling graph on all repositories, exposing secrets, or letting partial evidence unblock CI.
- No importing LiveReview code or changing ReviewRouter's existing Action v2 / server protocol.
- No runtime activation, deployment, release, protocol migration or credentials modification as part of this feature.

Independent licensing work belongs to separate PRs in `review-router` and `review-router-ai`.

## 3. Existing seams, clean architecture and SOLID/DRY

**Domain (pure):** Small `review-risk` module defines bounded signal types (`changed file`, `dependents`, `test hint`, `coverage completeness`, `finding severity`), priority category (`higher attention`, `normal`, `unknown`), evidence/reason codes, and deterministic sorting. No GitHub, filesystem, graph-builder or markdown dependency.

**Application:** An orchestrator maps existing diff/graph/impact/coverage data to domain signals. Reuses `src/analysis/context/graph-builder.ts`, `src/analysis/impact.ts`, `src/analysis/context/test-coverage-analyzer.ts` and `src/analysis/review-coverage.ts` selectively; does not rewrite them. If graph is unavailable, degrade gracefully and preserve regular review.

**Infrastructure adapters:** Read-only graph/diff mapping, existing summary publication and existing GitHub URL helpers. No persistent cache. Avoid duplicates of security, graph, or diff parsers.

**Presentation:** Reuse `src/output/reviewer-summary.ts`; no new GitHub comments or cards, only short labels and explanations. Validate/truncate paths and escape markdown/untrusted text; links bind to exact reviewed SHA.

Keep dependency direction inward: presentation/infra -> application -> pure domain. Use interfaces at actual existing seams, **not** a new generic DI container, event bus or framework. One responsibility per function, explicit invariants and tests.

**Important existing constraints:** `GRAPH_ENABLED=false` in default production setup; therefore production coverage cannot be claimed from experimental graph alone. The Action v2 and SaaS have independent source/protocol/release gates and must not be coupled. Do not amend long-running unrelated branches, especially interaction commands and hosted-runtime handoffs.

## 4. TDD specification before production code

Write focused failing tests for:
- Higher-use shared/auth dependency beats isolated larger UI change **only when graph edges are verified**.
- Equal inputs sort deterministically; size alone never proves blast radius.
- Unknown/partial graph and missing test evidence never produce an unjustified "safe" verdict.
- Changed-line filtering, rename handling and path normalization; bounded inputs/outputs for large PR.
- Severity remains unchanged and existing major/critical merge-blocking remains authoritative.
- No duplicate findings, extra provider invocations or extra GitHub publication mutations.
- All-clear PRs and incomplete reviews remain accurately labelled.
- Plain-language UX: at most three entries, short actionable explanations, exact SHA links, markdown escaping, localization/fallback.
- Golden snapshots/contract tests in the existing Jest suite; GitHub workflow E2E or clearly identify unavailable real-provider credentials (do not call mocked traffic live).

Tests must fail for the intended reason before implementation (red), then pass (green). Follow `npm run lint`, `npm run typecheck`, `npm test -- --runInBand`, `npm run build`, generated bundle parity/CI workflows and review rounds.

## 5. Implementation sequence, bounded PR

1. Confirm exact integration seam on current main and update this plan if source reality differs.
2. Add small domain with 2–4 reason codes and pure comparator. Tests first.
3. Add an application adapter for existing signals, **without** forcing full-repo graph analysis; separate evidence availability from risk.
4. Render an optional `Where to look first` subsection in the existing review summary with no extra user controls. Reuse standard labels/translation plumbing.
5. Add integration and GitHub E2E tests, build committed bundle, inspect screenshots/Markdown rendering and existing publication output.
6. Three bounded review passes: architecture/scope, security/correctness, UX/maintainability. Fix all actionable notes; rerun tests and CI after changes.
7. Only mark ready and merge after exact-HEAD checks, review, and actual E2E evidence are green. If a live provider is unavailable, accurately report the missing acceptance evidence; never call mock-only tests full E2E.

**Indicative added maintained LOC including tests/docs:** 900–1,600, target 1,200–1,500. Do not pad to hit a target. Any expansion beyond ~1,600 requires documented evidence and scope review.

## 6. Acceptance and observability

- User sees an understandable priority and evidence, or an explicit "not assessed" label, with no meaningless percentages.
- Existing inline findings, provider metrics, statuses and GitHub merge gate are unchanged for the same inputs.
- No unsafe access to repository code, credentials, external network or PR mutations; no unbounded graph traversal.
- No false claims of test coverage or precise risk probabilities.
- Tests cover complete, incomplete and zero findings, exact SHA binding and large PR.
- No effect on released Action v2 protocol or SaaS contract.
- Exact source SHA, CI jobs, generated-bundle state and review outcomes recorded in the PR before merge.

## 7. Critic rounds — resolved before implementation

**Round A: architectural critic.** Initial idea to build a new risk platform would duplicate AST, graph, coverage and reporting. **Resolution:** pure domain + one thin application adapter + existing summary. No database/worker/DI framework.

**Round B: correctness and security critic.** Graph context is experimental and missing data could wrongly produce a low-risk score or mutate gates. **Resolution:** explicit unknown state and evidence provenance, hard cost bounds, no policy mutation, SHA-locked links, default behavior preserved.

**Round C: UX and operations critic.** A numeric risk score without supporting evidence would create false precision and a second dashboard adds friction. **Resolution:** maximum three plain-language hotspots in the current summary; fallback explains uncertainty, no additional controls; require generated bundle and PR E2E.

**Round D: licensing critic.** LiveReview is source-available, not permissively reusable; `review-router` is derived from Keith Herrington's MIT upstream. **Resolution:** independent feature implementation; separate licensing audit and PRs retaining MIT notices where required. Do not imply Apache relicenses third-party code.

## 8. Independent implementation review (follow-up)

- **Correctness pass:** Found that the initial 2,000-candidate budget could truncate all late critical/major findings on a very large PR. Added an explicit >2,000-candidate regression test; all serious findings are now examined independently of the ordinary candidate budget. This remains a presentation-only change.
- **Evidence/UX pass:** Existing `CodeGraph.getDependents()` uses partial snapshot and heuristic module resolution; a counted edge cannot prove complete impact. Replaced strong “Referenced by” / “only verified” language with qualified *possible dependency* wording in all supported locales. No new graph/parser implementation.
- **Publication/architecture pass:** The feature adds no provider call, store, API, flag or gate, reuses source-revision URL validation, and renders inside the existing summary. Runtime must be rebuilt and compared at exact HEAD; test output and actual GitHub PR acceptance are required before merge.

These changes preserve the strict boundary: **attention hints are not safety verdicts, incident probabilities, coverage guarantees or merge policy**.

- **Third UX/maintainability pass:** On one or two ordinary findings, a second list merely repeated the normal review. The formatter now shows the priority section only for distinct dependency/coverage context or when more than three findings need prioritization. A real MarkdownFormatter regression asserts that a single major finding remains visible, linked to exact HEAD, and its blocking gate is unchanged. A separate same-basename path test prevents misleading source links.
