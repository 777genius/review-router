# GitHub App Bot Identity

Use a GitHub App installation token when you want review comments to appear from a custom bot account such as
`777genius-codex-reviewer[bot]` instead of `github-actions[bot]`.

## Permissions

Create a private GitHub App with these repository permissions:

- Contents: read
- Issues: write
- Pull requests: write (used for review comments and optional AI discussion replies)
- Actions: write (used by the interaction workflow to rerun failed review jobs after `/rr skip`)
- Metadata: read (GitHub grants this automatically)

No webhooks are required for GitHub Actions mode.

## Workflow Example

Store the App credentials:

```bash
gh variable set REVIEW_APP_CLIENT_ID --repo OWNER/REPO --body "Iv1..."
gh secret set REVIEW_APP_PRIVATE_KEY --repo OWNER/REPO < private-key.pem
```

Then mint an installation token before running the review action:

```yaml
permissions:
  actions: write
  contents: read
  issues: write
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create review GitHub App token
        id: app-token
        uses: actions/create-github-app-token@v3
        with:
          client-id: ${{ vars.REVIEW_APP_CLIENT_ID }}
          private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: ${{ github.event.repository.name }}
          permission-actions: write
          permission-contents: read
          permission-issues: write
          permission-pull-requests: write

      - uses: 777genius/review-router@v1
        with:
          GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          REVIEW_APP_SLUG: your-github-app-slug
```

`REVIEW_APP_SLUG` lets review thread lifecycle trust comments authored by
`your-github-app-slug[bot]`. Without it, lifecycle still remains safe, but old
App-authored ReviewRouter threads are treated as untrusted and will not be
auto-resolved or used for dedupe.

When `REVIEWROUTER_COMMENT_TOKEN_MODE=app-oidc` is active, lifecycle does not
trust `github-actions[bot]` unless the action explicitly fell back to
`GITHUB_TOKEN` for comment posting.

If GitHub accepts App-authored comments but rejects `resolveReviewThread` for
the App installation token, add the optional
`REVIEW_THREAD_LIFECYCLE_RESOLVE_TOKEN` secret. ReviewRouter uses that token only
for the final auto-close mutation after provider quorum; App-authored comments
and summaries remain App-authored.

## Manifest Template

```json
{
  "name": "777genius Codex Reviewer",
  "url": "https://github.com/777genius/review-router",
  "description": "Posts Codex-powered pull request reviews from a dedicated GitHub App bot identity.",
  "public": false,
  "default_permissions": {
    "actions": "write",
    "contents": "read",
    "issues": "write",
    "pull_requests": "write"
  },
  "default_events": []
}
```
