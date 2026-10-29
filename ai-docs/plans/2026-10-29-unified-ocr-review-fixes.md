# Action #346: resolve three verified A3 review findings

Planning checkpoint recorded before implementation, tests or builds. Baseline: Action A3
`fb132c4ed337141339d487e7c388518178c24b10`. All three actual CodeRabbit threads
are valid. After independent review, save this plan in the existing Action planning
area at `ai-docs/plans/2026-10-29-unified-ocr-review-fixes.md` before implementation;
root will push it with the reviewed source commit. Root owns commits, pushes,
review replies and merges.

## Minimal implementation

**T0 cancellation**, `src/codex-oauth/action.ts`, thread
`PRRT_kwDOSQsl5c6xwytV`: both listeners currently suppress Node's default exit for
legacy runs without delivering a cancellation signal to legacy runtime. Register
SIGINT/SIGTERM only for T0, before its workspace await. Initialize the optional
workspace path before the existing try/finally; put creation inside that scope and
call `runController.signal.throwIfAborted()` after creation, before runtime.
Preserve unconditional listener removal and owned-workspace removal in finally,
including creation rejection. The workspace helper already cleans partial creation
failures; it needs no change. Preserve existing failure reporting and legacy work.

**Empty token aliases**, `src/codex-oauth/claude-subscription-bootstrap.ts`, thread
`PRRT_kwDOSQsl5c6xwytm`: a defined empty optional alias precedes a valid canonical
token and makes preparation fail. Delete every alias as today; collect only
trim-nonempty values. Retain nonempty raw bytes for masking and existing normalized
validation/conflict rejection. Invalid nonempty values must never be skipped to
select another token.

**Admitted effort**, the same bootstrap, thread `PRRT_kwDOSQsl5c6xwytz`: pass captured
`runtimeConfig.runtimeEnv.CODEX_REASONING_EFFORT ?? null` into Anthropic startup.
When the captured env contains effort, OCR emits it, but startup expects null and
rejects its discovery envelope while verifier encoding omits effort. Keep normalization,
strict equality, dispatch accounting and codec policy unchanged; add no fallback.

## Focused regressions

Extend only three existing Action test files:

- `__tests__/unit/codex-oauth/action-setup-preview.test.ts`: reuse runtime/workspace
  spies. Deferred legacy work installs neither listener; inspect listener sets
  without sending a terminating signal to legacy/the test process. Active T0
  receives an aborted signal on cancellation. Cancel deferred T0 workspace creation
  through SIGINT/SIGTERM: after creation resolves, runtime never starts, workspace
  is removed, and listener sets return to baseline. Creation rejection likewise
  leaves no listeners or runtime. Restore test spies/listeners; retain normal cleanup.
- `__tests__/unit/codex-oauth/claude-subscription-bootstrap.test.ts`: cover both
  optional alias spellings empty/whitespace with a valid canonical token, all-empty
  rejection, conflicting valid tokens and invalid nonempty aliases with a valid
  canonical token. Assert all aliases removed; retain normalization/masking/lifetime
  coverage. Parameterize startup forwarding for admitted high effort and absent null.

- `__tests__/unit/review-orchestration/runner-local-anthropic-model-transport.test.ts`:
  make its existing shared-discovery/verifier scenario enter the real Claude
  bootstrap using an explicit fixture runtime config with high effort. Reuse its
  synthetic dispatch/upstream harness; assert successful discovery and verifier
  requests both carry high effort, preserve the exact prepared verifier hash, and
  share the captured account/budget. This component regression must fail with A3's
  bootstrap. Retain existing strict effort-mismatch denial; add no duplicate case
  or production transport/codec change.

This high-effort runtime config is **synthetic component admission**, not a claim
about current SaaS Claude settings. The current SaaS mapper emits reasoning effort
only for Codex-backed providers, Claude admission requires one Claude provider,
and no authoritative fixture override exists. Preserve offered production defaults;
change no mapper, authenticated checkout, route matrix or paired-test fixture. SaaS
changes are its existing exact Action pin and a short tracked plan note only.

## Validation and artifact handoff

Root's cache cleanup improved memory margin from about 200 to 850 MiB. Wait for
root's test/build resource authorization; reuse present dependencies. Use a private
TMPDIR under `action/tmp`. Run each focused suite in a separate sequential process,
with `NODE_OPTIONS=--max-old-space-size=512` and existing Jest settings:

```sh
npm test -- --runInBand --detectOpenHandles --testTimeout=20000 --runTestsByPath PATH
```

`PATH` is each of the three changed suites above, sequentially.
Run existing `node_modules/.bin/prettier --check` and
`node_modules/.bin/eslint` on the two source/three test paths; require no added
warnings and record any existing baseline count without unrelated cleanup. Format
only those paths when needed. Run `git diff --check`. Record resource failures
honestly; do not loop retries, install dependencies, change heap/timeouts/CI, or
repeat native builds locally. Required unchanged hosted CI supplies full lint,
typecheck, native qualification and actual-dist execution on the new exact head
(Node 24; 30-minute job; tests `--maxWorkers=2 --detectOpenHandles --testTimeout=20000`).

Regenerate committed runtime only through **`npm run build`**, then run
`npm run check:context-gateway-release-metadata`. Commit every actually changed
tracked output, including `dist/index.js` and its map; audit other output changes
against import reachability. Never hand-edit bundles/maps or generated handoff.

Keep exact S2 `8080881802d87f3bf700b15faa7cebb02f54ee9b`, all 64 generated digests,
eight curated wrappers, native rr.6/v3 manifest/binary, locks and workflows unchanged.
Add no migration/schema/UI/flag/auth-mode/release/activation work. A3 remains
immutable historical evidence. Publish reviewed A4, then immediately repin SaaS to
exact A4 with a short tracked plan note, so Action
and paired CI run in parallel. Both merges await all required new-head gates and
actual review findings; prior receipts retain their original heads. Preserve the
bot-appended PR body block. No deployment, tagging, release or runtime/channel promotion.

## Author self-review before implementation

| Round | Checked | Result |
| --- | --- | --- |
| 1 | Actual A3 callers, alias order and strict effort comparison. | GO: all three findings valid. |
| 2 | T0 await/throw cleanup, alias conflict denial, smallest unit plus real bootstrap-to-wire component proof and honest production defaults. | GO: no helper/codec refactor, production mapping change or duplicated harness. |
| 3 | Existing commands/resources, protected S2/native bytes and parallel exact-A4 pair qualification. | GO: independent review/root publication pending. |

## Implementation checkpoint

The bounded source and regression changes are included with this plan. Scoped
formatting and lint passed with zero warnings/errors; the official Action build
and context-gateway metadata check passed. Local Jest and typecheck were not run
because of the established resource constraint. Required CI on the published
successor must execute the focused regressions, full suite, typecheck, native
qualification and committed-artifact checks before merge. Final run outcomes
belong to the exact commit in PR checks; this note does not predeclare them passed.
