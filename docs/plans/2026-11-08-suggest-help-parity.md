# Post-merge UX parity: suggest-fix help

Scope: Action `/rr help` must list `/rr suggest fix` now that server PR #829 and Action PR #374 are merged. It must describe current-HEAD single-finding, qualified managed Gateway, human-applied GitHub suggestion, and no automatic changes. Do not modify routing, provider selection or server paths.

Steps:
1. Add one help entry adjacent to `/rr fixed` in `src/github/interaction.ts`.
2. Strengthen the existing `help` unit test to assert both commands.
3. Regenerate the tracked Action `dist` from source; no manual bundle edits.
4. Review; run exact-head CI and E2E; remove temporary generator; squash-merge only after success.
5. Check post-merge Action CI. Do not claim production-provider or manual GitHub UI Apply acceptance.

No additional abstractions, flags, provider requests or runtime dependencies.