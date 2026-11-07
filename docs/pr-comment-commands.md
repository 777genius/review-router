# GitHub PR commands

ReviewRouter interaction workflow commands:

| Comment | Behavior |
| --- | --- |
| `/rr help` or `@reviewrouter help` | Print installed Action command reference; no model call. |
| `/rr review`, `@reviewrouter review`, or legacy `@codex review` | Request current-head review, with write/maintain/admin permission. |
| `/rr status` or `@reviewrouter status` | Show signed skip/unskip overrides, not overall review health. |
| `/rr skip [reason]` | Signed override; direct reply to ReviewRouter inline finding, with maintainer policy. |
| `/rr unskip [reason]` | Undo override with same policy. |

The parser also recognizes textual `@reviewrouter-ai` aliases. Real GitHub mention notification requires the exact installed App account handle; `/rr` works regardless of the account name. The interaction workflow must be installed. Fork PRs cannot run secret-backed reviews. AI replies to ordinary comments on ReviewRouter findings depend on the qualified discussion workflow and selected account. The Action must be released and the pin updated to make new commands live. Full vs incremental review, rich run status, config, pause/resume and questions from top-level PR comments are tracked separately in [review-router-ai #823](https://github.com/777genius/review-router-ai/issues/823).
