# GitHub PR commands

ReviewRouter interaction workflow commands:

| Comment | Behavior |
| --- | --- |
| `/rr help` or `@reviewrouter help` | Print installed Action command reference; no model call. |
| `/rr review`, `@reviewrouter review`, or legacy `@codex review` | Request current-head review, with write/maintain/admin permission. |
| `/rr status`, `@reviewrouter status`, or `@review-router-ai status` | Show current PR HEAD and last matching GitHub Actions review status, plus signed skip/unskip overrides. Not a finding/coverage guarantee. |
| `/rr skip [reason]` | Signed override; direct reply to ReviewRouter inline finding, with maintainer policy. |
| `/rr unskip [reason]` | Undo override with same policy. |

The parser also recognizes textual `@reviewrouter-ai` and `@review-router-ai` aliases. The latter corresponds to the documented first-party App naming, but only the installed account's real login receives native GitHub mention notifications. Real GitHub mention notification requires the exact installed App account handle; `/rr` works regardless of the account name. The interaction workflow must be installed. Fork PRs cannot run secret-backed reviews. AI replies to ordinary comments on ReviewRouter findings depend on the qualified discussion workflow and selected account. The Action must be released and the pin updated to make new commands live. Full vs incremental review, rich run status, config, pause/resume and questions from top-level PR comments are tracked separately in [review-router-ai #823](https://github.com/777genius/review-router-ai/issues/823).

On qualified managed installations, inline questions and `/rr explain` use the existing conversation flow when enabled; this requires the same-repository PR, an eligible provider and read-only question handling. Legacy conversations do not have a concurrent-delivery replay guarantee. Unsupported review modes (`full`, `security`, and custom scopes) are rejected, never interpreted as plain review.

Read-only `/rr help` and `/rr status` run for a newly created PR comment, not on edits to the same comment (to avoid repeated bot notices). `/rr skip` and `/rr unskip` continue accepting multi-line reasons in a direct inline reply. Changes to commands in old comments require a new PR comment.

`/rr fixed` (or `@review-router-ai fixed`) is a separate, read-only targeted verification request in a direct reply to a ReviewRouter finding. It is available only to authorized same-repository maintainers through the qualified managed Gateway. A verified result reports **Fixed**, **Still present**, or **Cannot verify** with current-HEAD evidence; it does not dismiss, skip, resolve or automatically change code. In an unsupported legacy or unqualified installation, it does not run a paid revalidation.
