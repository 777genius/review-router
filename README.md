# AI Robot Review

AI Robot Review is a GitHub Action for pull request review with Codex CLI, OpenAI API, or OpenRouter.

Current focus: a practical PR reviewer that can run from GitHub Actions, post a PR summary, post a small number of inline findings, and optionally fail the check on serious issues. The Codex path is designed to use a ChatGPT subscription OAuth login instead of OpenAI API billing.

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

What should still be treated as experimental:

- Multi-provider consensus beyond the simple one-provider Codex setup.
- Code graph context on large mixed-language repos.
- Analytics, learning, plugin, and self-hosted flows inherited from the upstream project.

## Core Features

- **Codex subscription mode:** run reviews with Codex CLI OAuth from a ChatGPT subscription.
- **API key mode:** use OpenAI API key or OpenRouter API key instead.
- **GitHub identity options:** post as `github-actions[bot]` or as your own GitHub App bot.
- **Read-only agentic context:** Codex starts from the PR diff, then may inspect related repository files in a read-only sandbox.
- **Strict JSON findings:** provider output is parsed into `{file,line,severity,title,message,suggestion}` before posting.
- **Inline comments:** posts only valid comments on changed lines, with severity labels in the comment body.
- **PR summary:** updates one summary comment instead of creating a new summary on every run.
- **PR description summary:** adds a generated `Summary`, selected files list, and walkthrough block while preserving author text above it.
- **Merge gating:** fail the check for critical or major findings when configured.
- **Large diff compaction:** compact very large, generated, lockfile, and migration diffs so they do not dominate the prompt.
- **Secret handling:** fork PRs are skipped by default, Codex runs with a sanitized environment, and GitHub secrets are not printed.

## Non-Goals For v1

- No hosted SaaS backend.
- No shared global branded GitHub App.
- No automatic mutation of repository files.
- No automatic deletion or moving of old inline discussions by default.
- No claim that token or dollar cost is available for Codex subscription OAuth. For OAuth runs the UI reports `OAuth subscription` instead of API billing cost.

## Quick Start

Run the installer from a local checkout of the repository you want to configure:

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | bash
```

The installer:

- detects or asks for the target `owner/repo`;
- lets you choose `github-actions[bot]` or GitHub App bot identity;
- lets you choose Codex subscription OAuth, OpenAI API key, or OpenRouter API key;
- creates `.github/workflows/ai-robot-review.yml` on a setup branch;
- opens a setup PR instead of pushing directly to the default branch.

See [docs/install.md](./docs/install.md) for organization-level secrets, selected repositories, GitHub App setup, and security notes.

## Recommended Codex Workflow

```yaml
name: AI Robot Review

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
  group: ai-robot-review-${{ github.event.pull_request.number || inputs.pr_number || github.ref }}
  cancel-in-progress: true

jobs:
  review:
    if: ${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.fork != true }}
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
        run: |
          test -n "$CODEX_AUTH_JSON"
          mkdir -p ~/.codex
          printf '%s' "$CODEX_AUTH_JSON" > ~/.codex/auth.json
          chmod 600 ~/.codex/auth.json
          if [ -n "$CODEX_CONFIG_TOML" ]; then
            printf '%s' "$CODEX_CONFIG_TOML" > ~/.codex/config.toml
            chmod 600 ~/.codex/config.toml
          fi

      - name: Verify Codex OAuth headless mode
        env:
          CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}
        run: |
          codex exec --model "$CODEX_MODEL" --sandbox read-only --ephemeral --ignore-user-config -c approval_policy=never -c model_reasoning_effort='"low"' --output-last-message /tmp/codex-smoke.txt "Respond with exactly: codex-oauth-ok"
          grep -q "codex-oauth-ok" /tmp/codex-smoke.txt

      - name: Run AI Robot Review
        uses: 777genius/multi-provider-code-review@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.pull_request.number || inputs.pr_number }}
          CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}
          CODEX_REASONING_EFFORT: 'medium'
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

For strict blocking, set:

```yaml
FAIL_ON_MAJOR: 'true'
```

Then make `AI Robot Review / review` a required status check in branch protection.

## Provider Modes

### Codex OAuth Subscription

Use this when you want Codex through your ChatGPT subscription.

Required secrets or organization selected-repo secrets:

- `CODEX_AUTH_JSON`: contents of `~/.codex/auth.json`
- `CODEX_CONFIG_TOML`: optional, usually leave unset unless you intentionally need local Codex config in CI

Recommended variable:

- `REVIEW_CODEX_MODEL=gpt-5.5`

### OpenAI API Key

Use this when shared automation should not depend on a personal Codex OAuth login.

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
| `UPDATE_PR_DESCRIPTION` | `true` | Adds or updates only the generated AI Robot Review block. |
| `SMART_DIFF_COMPACTION` | `true` | Summarizes oversized/generated diffs before prompt construction. |
| `GRAPH_ENABLED` | `false` | Optional code graph context. Keep off until validated for your repo. |
| `LEARNING_ENABLED` | `false` | Experimental feedback-learning path. |

## Comment Deduplication

AI Robot Review suppresses duplicate inline comments when a rerun reports the same issue again. The dedup check uses:

- hidden inline fingerprints for exact matches;
- same file and severity;
- nearby line distance;
- semantic overlap in title/body/code tokens.

It intentionally does not delete or move existing inline discussions by default. Deleting old comments can hide review history and is easy to get wrong when a model slightly changes wording. If a future lifecycle mode is added, it should be opt-in and heavily tested.

## Security Notes

- Do not run secret-backed review on untrusted fork PRs. The installer-generated workflow skips those by default.
- GitHub Secrets values are hidden in the UI, but anyone who can change workflow files can attempt exfiltration. Protect `.github/workflows/**` with CODEOWNERS and branch protection.
- For organizations, prefer organization-level selected-repository secrets so the Codex OAuth credential is only available to approved repos.
- Codex provider runs with a sanitized environment and read-only sandbox. It should not receive `GITHUB_TOKEN`, `OPENROUTER_API_KEY`, or arbitrary `INPUT_*` variables.

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
