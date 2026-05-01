# ReviewRouter

ReviewRouter is a GitHub Action for pull request review with Codex, OpenRouter, and experimental CLI providers for Claude Code, Gemini, and OpenCode.

The production-focused installer currently hardens the Codex and OpenRouter paths first. The other provider adapters are still available through `REVIEW_PROVIDERS`, but they are not yet the recommended zero-config setup path.

Current focus: a practical PR reviewer that can run from GitHub Actions, post a PR summary, post a small number of inline findings, and optionally fail the check on serious issues. The Codex path is designed to use a ChatGPT subscription OAuth login instead of OpenAI API billing.

## Quick Start

Run the installer inside the local checkout of the repository you want to configure:

```bash
cd /path/to/your-repo
curl -fsSL https://raw.githubusercontent.com/777genius/review-router/main/scripts/install.sh | bash
```

That is the recommended path because the installer can detect the GitHub remote, create a setup branch, write `.github/workflows/review-router.yml`, push the branch, and open a setup PR.

If you run it outside a git checkout, it can still ask for `owner/repo` and use the GitHub API, but the local-checkout flow is easier to inspect before merging.

The installer:

- detects or asks for the target `owner/repo`;
- lets you choose `github-actions[bot]` or GitHub App bot identity;
- lets you choose Codex subscription OAuth, Codex CLI with OpenAI API key, or OpenRouter API key;
- lets you choose stable `v1`, a pinned exact release tag, or live `main` for the generated workflow;
- creates `.github/workflows/review-router.yml` on a setup branch;
- opens a setup PR instead of pushing directly to the default branch.

See [docs/install.md](./docs/install.md) for organization-level secrets, selected repositories, GitHub App setup, and security notes.

By default, the generated workflow uses `777genius/review-router@v1`, a stable major tag that moves to the latest compatible v1 release. Use `REVIEW_ROUTER_ACTION_REF_MODE=release` for an exact pinned tag, or `REVIEW_ROUTER_ACTION_REF_MODE=main` for the live branch.

## Status

This is an actively stabilized fork of `keithah/multi-provider-code-review`.

What has been tested end-to-end:

- Codex CLI OAuth in GitHub Actions using `~/.codex/auth.json` restored from GitHub Secrets.
- `codex exec` in read-only sandbox mode with strict JSON output for inline review comments.
- PR summary comment updates.
- PR description summary block updates without overwriting author text.
- Inline comments on changed lines.
- Duplicate suppression across reruns when the model rewrites the same finding or the line shifts slightly.
- Blocking merge checks with `FAIL_ON_MAJOR=true` or `FAIL_ON_CRITICAL=true`.

Available but still experimental:

- Multi-provider consensus beyond the simple one-provider Codex setup.
- OpenAI API-key mode through Codex CLI and OpenRouter mode. The installer can generate these workflows, but the most hardened E2E path is Codex OAuth.
- Claude Code, Gemini CLI, and OpenCode adapters. They exist in the engine, but still need the same read-only sandboxing, strict schema enforcement, env sanitization, installer credential setup, and real PR E2E coverage as the Codex path.
- Code graph context on large mixed-language repos.
- Analytics, learning, plugin, and self-hosted flows inherited from the upstream project.

## Core Features

- **Codex subscription mode:** run reviews with Codex CLI OAuth from a ChatGPT subscription.
- **API key modes:** use Codex CLI with `OPENAI_API_KEY`, or use OpenRouter with `OPENROUTER_API_KEY`.
- **GitHub identity options:** post as `github-actions[bot]` or as your own GitHub App bot.
- **Reusable App profiles:** create a GitHub App once, then reuse its saved local profile for more repositories.
- **Read-only agentic context:** Codex starts from the PR diff, then may inspect related repository files in a read-only sandbox.
- **Strict JSON findings:** provider output is parsed into `{file,line,severity,title,message,suggestion}` before posting.
- **Inline comments:** posts only valid comments on changed lines, with severity labels in the comment body.
- **PR summary:** updates one summary comment instead of creating a new summary on every run.
- **PR description summary:** adds a generated `Summary`, selected files list, and walkthrough block while preserving author text above it.
- **Merge gating:** fail the check for critical or major findings when configured.
- **Human override:** reply `/rr skip` to a ReviewRouter inline comment to dismiss that finding after a maintainer confirms it is not actionable.
- **AI discussion replies:** with Codex auth modes, ordinary replies to ReviewRouter findings can get an AI explanation. If the model agrees a finding is likely a false positive, it suggests `/rr skip`; it does not unblock CI by itself.
- **Large diff compaction:** compact very large, generated, lockfile, and migration diffs so they do not dominate the prompt.
- **Review scope report:** the summary shows full-diff, compacted, metadata-only, and skipped file counts so large PRs are auditable.
- **Secret handling:** fork PRs are skipped by default, Codex runs with a sanitized child-process environment, and workflows avoid printing secret values.

## Security Model

ReviewRouter is designed for trusted repository automation, not for running arbitrary untrusted PR code with secrets.

- The generated review workflow uses `pull_request`, not `pull_request_target`.
- Fork PRs skip secret-backed review by default.
- Codex runs in a read-only sandbox and receives a sanitized child-process environment.
- Codex OAuth stores ChatGPT-managed `auth.json` as an Actions secret. Use this only for trusted private automation.
- For public/open-source repositories, prefer OpenAI API-key mode or OpenRouter instead of personal Codex OAuth.
- Protect `.github/workflows/**`, `action.yml`, `scripts/install.sh`, `src/**`, and `dist/**` with CODEOWNERS and branch protection.

GitHub-hosted runners are ephemeral. Codex can refresh `auth.json`, but the refreshed file disappears when the job ends unless you use a trusted self-hosted runner with persistent `CODEX_HOME` or a separate secure storage write-back flow. ReviewRouter does not write refreshed personal OAuth credentials back to repository secrets by default.

## Non-Goals For v1

- No hosted SaaS backend.
- No shared global branded GitHub App.
- No automatic mutation of repository files.
- No automatic CI unblock from free-form human text by default.
- No automatic deletion or moving of old inline discussions by default.
- No claim that token or dollar cost is always available for Codex subscription OAuth. For OAuth runs the UI reports `OAuth subscription` instead of API billing cost.

## Recommended Codex Workflow

```yaml
name: ReviewRouter

on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number
        required: true

permissions:
  contents: read
  issues: write
  pull-requests: write

concurrency:
  group: review-router-${{ github.event.pull_request.number || inputs.pr_number || github.ref }}
  cancel-in-progress: true

jobs:
  review:
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.fork != true }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v6
        with:
          node-version: '24'

      - name: Install official Codex CLI
        run: npm install -g @openai/codex@0.125.0

      - name: Restore Codex OAuth config
        env:
          CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
          CODEX_CONFIG_TOML: ${{ secrets.CODEX_CONFIG_TOML }}
          REVIEW_ROUTER_CODEX_AUTH_PERSISTENCE: secret
        run: |
          test -n "$CODEX_AUTH_JSON"
          export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
          mkdir -p "$CODEX_HOME"
          chmod 700 "$CODEX_HOME"
          printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"
          chmod 600 "$CODEX_HOME/auth.json"
          if [ -n "$CODEX_CONFIG_TOML" ]; then
            printf '%s' "$CODEX_CONFIG_TOML" > "$CODEX_HOME/config.toml"
            chmod 600 "$CODEX_HOME/config.toml"
          fi

      - name: Run ReviewRouter
        uses: 777genius/review-router@v1
        env:
          REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.pull_request.number || inputs.pr_number }}
          CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}
          CODEX_REASONING_EFFORT: 'medium'
          CODEX_HEALTHCHECK_MODE: 'binary'
          CODEX_AGENTIC_CONTEXT: 'true'
          FAIL_ON_NO_HEALTHY_PROVIDERS: 'true'
          INLINE_MAX_COMMENTS: '5'
          INLINE_MIN_SEVERITY: major
          MIN_CONFIDENCE: '0.6'
          CONSENSUS_REQUIRED_FOR_CRITICAL: 'false'
          UPDATE_PR_DESCRIPTION: 'true'
          FAIL_ON_CRITICAL: 'true'
          FAIL_ON_MAJOR: 'false'
          ENABLE_AST_ANALYSIS: 'true'
          ENABLE_SECURITY: 'true'
          ENABLE_AI_DETECTION: 'false'
          LEARNING_ENABLED: 'false'
          GRAPH_ENABLED: 'false'
```

The installer also writes a separate non-required interaction workflow:

```yaml
name: ReviewRouter Interaction

on:
  pull_request_review_comment:
    types: [created, edited]

permissions:
  actions: write
  contents: read
  issues: write
  pull-requests: write

jobs:
  interaction:
    if: ${{ github.event.pull_request.head.repo.fork != true && github.event.comment.user.type != 'Bot' && (startsWith(github.event.comment.body, '/rr ') || vars.REVIEW_ROUTER_DISCUSSION_MODE == 'suggest') }}
    runs-on: ubuntu-latest
    steps:
      - name: Preflight ReviewRouter interaction
        id: preflight
        uses: 777genius/review-router@v1
        with:
          REVIEW_ROUTER_MODE: interaction-preflight
          REVIEW_ROUTER_DISCUSSION_MODE: ${{ vars.REVIEW_ROUTER_DISCUSSION_MODE }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      # Codex setup is conditional and only runs when a plain-text discussion reply
      # needs an AI answer. /rr skip stays fast and does not start Codex.

      - name: Handle ReviewRouter interaction
        if: steps.preflight.outputs.should_run == 'true'
        uses: 777genius/review-router@v1
        env:
          REVIEW_ROUTER_LEDGER_KEY: ${{ secrets.REVIEW_ROUTER_LEDGER_KEY }}
        with:
          REVIEW_ROUTER_MODE: interaction
          REVIEW_ROUTER_DISCUSSION_MODE: ${{ vars.REVIEW_ROUTER_DISCUSSION_MODE }}
          REVIEW_ROUTER_REVIEW_WORKFLOW_FILE: review-router.yml
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

For strict blocking, set:

```yaml
FAIL_ON_MAJOR: 'true'
```

Then make `ReviewRouter / review` a required status check in branch protection.

If you want an exact pinned release instead of the auto-updating stable major tag, use:

```yaml
uses: 777genius/review-router@v1.0.2
```

If you intentionally want the live branch, use:

```yaml
uses: 777genius/review-router@main
```

## Provider Modes

### Codex OAuth Subscription

Use this when you want Codex through your ChatGPT subscription.

Required secrets or organization selected-repo secrets:

- `CODEX_AUTH_JSON`: contents of `~/.codex/auth.json`
- `CODEX_CONFIG_TOML`: optional, usually leave unset unless you intentionally need local Codex config in CI

Recommended variable:

- `REVIEW_CODEX_MODEL=gpt-5.5`

### Codex CLI With OpenAI API Key

Use this when shared automation should not depend on a personal Codex OAuth login. This still runs through Codex CLI, but authenticates with `OPENAI_API_KEY`.

Required secret:

- `OPENAI_API_KEY`

### OpenRouter API Key

Use this if you want model routing through OpenRouter.

Required secret:

- `OPENROUTER_API_KEY`

## Important Inputs

| Input | Default | Notes |
|---|---:|---|
| `CODEX_MODEL` | empty | Codex model id, for example `gpt-5.5`. |
| `CODEX_REASONING_EFFORT` | empty | Codex effort for review runs, for example `medium`. |
| `CODEX_AGENTIC_CONTEXT` | `true` | Lets Codex inspect related files in read-only mode. |
| `INLINE_MAX_COMMENTS` | `5` | Caps inline comment noise. |
| `INLINE_MIN_SEVERITY` | `major` | Controls which findings become inline comments. |
| `MIN_CONFIDENCE` | empty | Optional confidence threshold for inline suggestions. |
| `FAIL_ON_CRITICAL` | `true` | Fails the check on critical findings. |
| `FAIL_ON_MAJOR` | `false` | Set `true` to block PRs on major findings. |
| `UPDATE_PR_DESCRIPTION` | `true` | Adds or updates only the generated ReviewRouter block. |
| `SMART_DIFF_COMPACTION` | `true` | Summarizes oversized/generated diffs before prompt construction. |
| `GRAPH_ENABLED` | `false` | Optional code graph context. Keep off until validated for your repo. |
| `LEARNING_ENABLED` | `false` | Experimental feedback-learning path. |

## Review Scope And Limits

- The default production-friendly setup reviews the full PR diff on each run and relies on deduplication to avoid repeated inline comments.
- It does not guarantee finding every bug. Treat it as an automated reviewer, not a replacement for required human review.
- Inline comments can only be posted on changed diff lines. Findings that depend only on unchanged context may be summarized or omitted if they cannot be anchored safely.
- Agentic context is read-only. Codex may inspect related files, but should not install dependencies, run tests, run builds, access network resources, or write files.
- Large generated files, lockfiles, and migrations are compacted to protect prompt budget. This is intentional, but it means those files may receive less detailed review.

## Comment Deduplication

ReviewRouter suppresses duplicate inline comments when a rerun reports the same issue again. The dedup check uses:

- hidden inline fingerprints for exact matches;
- same file and severity;
- nearby line distance;
- semantic overlap in title/body/code tokens.

It intentionally does not delete or move existing inline discussions by default. Deleting old comments can hide review history and is easy to get wrong when a model slightly changes wording. If a future lifecycle mode is added, it should be opt-in and heavily tested.

## Human Overrides

If ReviewRouter posts a blocking finding that a maintainer has verified as not actionable, reply to that inline comment with:

```text
/rr skip
/rr skip optional reason
```

The reason is optional. `/rr skip` is handled by the separate `ReviewRouter Interaction` workflow. It writes a signed PR ledger comment, then reruns the failed `ReviewRouter / review` check when the token has `actions: write`.

Permission policy:

- Critical and Major findings require `maintain` or `admin`.
- Minor findings allow `write`, `maintain`, or `admin`.
- PR authors cannot skip blocking findings by default.

The signed ledger prevents a manually edited bot-looking comment from unblocking a PR.

With Codex auth modes, the installer sets `REVIEW_ROUTER_DISCUSSION_MODE=suggest`. In that mode, ordinary human replies to ReviewRouter inline findings can receive an AI explanation in the same review thread. If the AI agrees the finding is likely a false positive, it suggests that a maintainer reply `/rr skip`. The AI discussion path does not write the ledger and does not unblock CI.

## Security Notes

- Do not run secret-backed review on untrusted fork PRs. The installer-generated workflow skips those by default.
- GitHub Secrets values are hidden in the UI, but anyone who can change workflow files can attempt exfiltration. Protect `.github/workflows/**` with CODEOWNERS and branch protection.
- For organizations, prefer organization-level selected-repository secrets so the Codex OAuth credential is only available to approved repos.
- The spawned Codex process receives only allowlisted environment variables such as `PATH`, `HOME`, temp variables, locale variables, `GITHUB_WORKSPACE`, and `OPENAI_API_KEY` when API-key mode is used. It should not receive `GITHUB_TOKEN`, `OPENROUTER_API_KEY`, or arbitrary `INPUT_*` variables.

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test -- --runInBand
npm run build
git diff --check
```

The action bundle is committed in `dist/`, so run `npm run build` before committing code changes that affect the action runtime.

## Documentation

- [Installer guide](./docs/install.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Security guide](./docs/SECURITY.md)
- [Performance guide](./docs/PERFORMANCE.md)
