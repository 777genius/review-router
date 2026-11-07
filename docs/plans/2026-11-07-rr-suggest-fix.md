# PR command: `/rr suggest fix` — one bounded GitHub suggestion

Status: implementation plan accompanying a separate Draft PR. Action baseline `fcc3e1d6bfd1208a9a36a8b2f6fb018dd1b0cbaf`; independent of the `/rr fixed` code beyond existing shared inline finding lookup.

## Goal and explicit exclusions

Reply `/rr suggest fix` under **one** ReviewRouter inline finding. Produce a GitHub `suggestion` fenced code block for an exact, still-applicable RIGHT-side hunk of the **current** PR HEAD. Human can click Apply. Do not push, auto-commit, execute model-generated shell commands, apply branch edits or mutate review state.

## Small design

1. Extend the allowlisted command parser and existing reply dispatch; validate the parent comment against the live GitHub API and a verified finding marker. Same-repo and qualified provider only. Validate author permission for a paid request, current head SHA and source comment revision; no free-form model options.
2. Reuse `validateSuggestionRange`, `formatSuggestionBlock` and existing sanitizer. Proposal is bounded to one current file and an exact contiguous RIGHT-side range of current GitHub PR diff; no rename/deletion/sensitive path, outdated or unsupported line. Use the existing model policy/selected account and original finding, not a second persistent memory store.
3. Re-read PR head and target diff immediately before publication; verify proposed replacement is nonempty, bounded (≤50 lines), no unsupported control characters, valid contiguous range. Refuse `suggestion` block on ambiguity/stale HEAD or unavailable AI; display safe no-suggestion message instead.
4. One reply at most per command revision, respecting current conversation publication/claim semantics. No new cross-service framework or durable job queue.

## Acceptance / E2E

Valid exact-current one-line and multi-line RIGHT-side suggestions, quoting/backtick fences; patch has no RIGHT-side lines, crossing hunks, removed path, outdated line, changed head, malicious paths, oversized proposal, invalid code output; outsider/fork/bot/edited source; duplicate/concurrent events; provider missing; user applies suggestion manually in a disposable PR; no automatic commits. E2E must verify the exact rendered GitHub UI and no changes to branch or check results.

## Budget and boundaries

Target 280–650 manually maintained LOC including tests/docs, excluding generated bundles. If no reliable qualified provider or existing source-bound suggestion payload is available, do **not** invent a plausible code fix. Fail closed, and surface a narrow dependency rather than widening scope. Keep this change a separate PR and merge only after the prerequisite command/production qualification if it actually depends on it.

Review passes: security/input provenance; exact HEAD/diff/markdown applicability; replay/UX; tests and production release pins.