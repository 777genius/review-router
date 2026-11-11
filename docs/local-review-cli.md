# Local ReviewRouter CLI (native OCR and legacy engines)

The `review-router` command (also available as `mpr`) reviews local Git changes **without publishing a GitHub comment**. The native OpenCodeReview (OCR) engine is **explicit opt-in**; the existing ReviewRouter legacy path remains the default for backward compatibility.

> This page describes the experimental implementation in this PR, not an already released npm version. Native OCR is a local process with the permissions of the invoking user, **not** the managed/hosted ReviewRouter OCR pipeline.

## Quick start

Install/build ReviewRouter as documented for your environment, then in the Git repository being reviewed:

```sh
review-router help
review-router doctor
review-router review                           # existing tracked-only legacy behavior
review-router review --engine ocr              # native OCR workspace review
review-router review --engine ocr --include-untracked
review-router review --engine ocr --scope branch --base origin/main
review-router review --engine ocr --scope commit --ref HEAD
review-router review main..feature --format json  # legacy exact-tip range with JSON
review-router review --format json              # legacy engine in the same JSON schema
review-router review --engine ocr --format json
review-router review --engine ocr --preview
```

Native OCR requires a compatible executable reporting version `1.13.1` (including the qualified ReviewRouter-patched `1.13.1-rr.*` build). Place it on `PATH` as `ocr`, or set `REVIEWROUTER_OCR_BINARY` to a trusted **absolute path**. `doctor` checks installed binary/version; it does **not** verify authentication or send a model request. Set up the provider/model in OCR's own user-level configuration (see [pinned OCR CLI documentation](https://github.com/alibaba/open-code-review/blob/v1.13.1/pages/src/content/docs/en/cli-reference.md)); `--provider` and `--model` override the native OCR choice for a single invocation. The CLI never silently switches to another engine/provider.

### Scope and privacy

| Command | Actual input | Important caveat |
|---|---|---|
| `review-router review` | Existing legacy review: tracked staged + unstaged files | Untracked files are not included |
| `--engine ocr` | OCR workspace mode: tracked + nonignored untracked | New files require explicit `--include-untracked` consent; without it review is refused before OCR runs |
| `--engine ocr --scope branch --base <ref>` | `merge-base(<ref>, HEAD)..HEAD` | Requires a clean worktree; no implicit `git fetch` |
| `--engine ocr --scope commit --ref <ref>` | Exact commit versus parent | Requires a clean worktree; no automatic commit |
| `--engine ocr --preview` | Native model-free file selection | Shows selected paths in text (up to 20) and all paths in JSON `coverage.selectedPaths`; does not call an LLM |
| `review main..feature --format json` | Legacy diff between named commit tips | The same range as legacy non-JSON; native OCR instead uses merge-base |

Not in this delivery: `--scope staged`, automatic `outgoing` inference, push hooks, automatic edits, remote publication, first-party IDE extension or GitHub App. The already installed development `pre-commit` hook is **not** an AI pre-push review.

**Data and trust:** Selected code is sent to the provider configured in the chosen engine, and OCR may use read-only context tools to inspect related repository files. OCR's local process has the invoking user's filesystem permissions; it is **not an OS sandbox**. Do not run against an untrusted checkout or sensitive repository without understanding OCR's configuration and model endpoint. Native OCR may persist local session logs including comments and model reasoning under its own user-level directory. Keep them private. ReviewRouter does not print native `thinking` in its normalized JSON or terminal output. No GitHub token, ReviewRouter SaaS or Account Gateway is needed for the native local path.

### Running from coding agents

```sh
review-router review --engine ocr --scope branch --base origin/main --format json
```

Stdout is **one versioned JSON object** for explicit JSON mode. Check `schemaVersion` and `status` **before accessing any other fields**. A review outcome has `coverage.complete`, optional `coverage.selectedPaths`, `engine.id`, `input.snapshotDigest`, `summary`, `findings` and `warnings`. A preflight or execution failure instead returns `{"schemaVersion":1,"status":"failed","error":{"kind":"usage|execution|interrupted","message":"..."}}` and may not have `coverage` or `engine`. Agents must branch on this union rather than assuming all fields always exist. Never treat an empty `findings` array as clean unless the status is `complete` and coverage is complete. `partial`, `stale`, `failed` and `skipped` mean no affirmative clean result. OCR's own terminal manifest and model attribution are validated; a native exit code 0 alone cannot prove completeness. Native preview exclusions are reported: policy-excluded files remain outside the selected review, while unsupported files (for example `too_large`) make the outcome incomplete, even if all selected files were reviewed.

New explicit-mode exit codes: `0` complete without classified blocking findings (or clearly identified `skipped`); `1` complete with major findings; `2` complete with critical findings; `3` incomplete/failed/stale; `4` invalid options or unavailable requested engine; `130` interrupt when supported. Read status even when the exit code is 0. Old implicit legacy CLI behavior retains its exit codes.

The native engine does not automatically apply hosted ReviewRouter's lifecycle, triage, Gateway evidence or publication. The `legacy` engine continues using the existing local ReviewOrchestrator. Native OCR brings its own file grouping, context tools, rule/filter selection and multi-round LLM review without rewriting those algorithms in TypeScript.

### Testing this change

```sh
npm ci
npm run build:cli
npm test -- __tests__/unit/local-review --runInBand
node scripts/local-review-cli-e2e.cjs
```

The E2E fixture uses **real Git operations** and a local deterministic fake OCR executable: it does not spend model tokens or prove actual model accuracy. The CI matrix covers Ubuntu, macOS and Windows. A separately authorized, live provider smoke and pinned native binary qualification are required for a production-quality release; do not describe a fake fixture as live model E2E.

[Architecture, limits and review gates](plans/2026-11-09-local-review-engine-neutral.md).
