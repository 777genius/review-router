# Captured review Skills

Review Skills supply text instructions to both the managed OpenCodeReview engine
and the native reviewer. A workspace assigns canonical web Skills to repositories;
authors edit the original, and a new review captures its current immutable revision.
An admitted run keeps its captured revision when retried or restored. Changes to
assignments, sharing grants or content affect subsequent runs.

## Execution contract

A qualified registered profile advertises `reviewSkillsVersion: 1`. The producer
reads `POST /api/action/v2/skills` with its existing run bearer and `{}` request.
The response is the bare versioned `CapturedReviewSkills` document. It is bounded
to 256 KiB, decoded as strict UTF-8 and validated before cache lookup or inference.
The snapshot is kept in memory; it is not placed in environment variables, token
claims, logs or telemetry. An unavailable endpoint, invalid digest, mismatching
base revision, unsupported attachment or excess limit stops the run.

Web instructions are intentionally user-managed content stored by the control
plane. Repository Skill bodies remain in the execution runtime. The control plane
captures only the trusted base SHA and configured Git roots. The runtime resolves
those roots from that exact commit and adds a digest of the resolved text to its
execution identity. Checkout HEAD is never a substitute.

Supporting empty captures remain explicit captures. Historical profiles without
the capability keep their prior behavior, including the old OCR rr.3 rule bytes
and cache identities. The corrected OCR transport belongs to `ocr-managed-v3`
(`1.13.1-rr.4`); its registered predecessor identities remain unchanged. The native
supporting profile is `codex-skills-v1`, with the already verified Codex 0.147.0
binary. Captured explicit profile choices are never silently replaced.

| Admitted execution route                                           | Skills delivery                                                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Account Gateway, managed OCR or native                             | Supporting registered profiles receive the captured input.                                                     |
| Verified direct OpenRouter provider API                            | Supporting native profile receives the captured input.                                                         |
| Older GitHub Secrets/Hosted caller without the admitted-input seam | Retained legacy profile; new admissions with assignments or Git sources fail with `skills_engine_unsupported`. |

The broad `provider_api` model transport label is insufficient to select a
supporting profile. The control plane requires the verified direct OpenRouter
route; an absent or ambiguous legacy profile fails closed on older callers.

## Scope

Web bindings use repository-relative, case-sensitive POSIX patterns. Supported
operators are `*`, `?`, and `**` as an entire path segment. Dotfiles are included.
Include patterns are combined as a union, then excludes are subtracted. Absolute
paths, drive prefixes, backslashes, empty/dot/traversal segments, bracket classes,
braces, extglobs, negation and comments are rejected. The default is `**` with no
excludes. Every matching assigned Skill contributes; ordering is deterministic.

OCR receives one composed exact-path rule for each admitted reviewed file, with
`merge_system_rule: true`, so its built-in language rules remain present. The
managed patch performs case-sensitive literal matching and enforces the exact
assigned inventory before grouping or any model request. The ordinary upstream
glob resolver remains available for legacy profiles. Upstream `include` is a
force-include feature, and is not used as an allowlist.

The native finding and investigation prompts receive the same captured policy
with exact path labels. Native prompts include each applicable Skill body and
its Markdown resources once, labeled with its sorted, unique matching reviewed
paths; overlapping Skills each retain their own path list.
OCR retains a complete composed rule for every exact reviewed path. Skills grant
no additional tools, commands, network access or file scope. Provenance means the
instructions were supplied; it does not certify that a model performed each
requested check.

## Review output

When Skills are configured, the published review and check summary include one
collapsed **Review skills** section. It reports web Skills as aggregate counts;
names, instructions, IDs and source workspaces are not published. Repository
Skills are identified only by paths from the reviewed repository at the captured
trusted base. Captured/materialized digests and the base SHA identify the input.
Missing roots and roots with no immediate discoverable `SKILL.md` files have
separate status messages. These local diagnostics do not change captured bytes or
cache identity.

Matching changed paths, accepted review evidence, and fresh instruction supply
are distinct. Native execution requires a finite positive transport request-count
delta across successful execution; its witnesses include actual prompt paths even
when code coverage is partial. Managed OCR requires a finite positive
request-count delta around the actual process dispatch. Its receipt confirms
aggregate delivery of the controlled rules, while individual Skill/path delivery
remains unconfirmed. Preparation, deterministic previews, and materialization
never establish fresh supply. A local execution witness must match both the
invocation key and payload hash of evidence accepted for publication.

If no such witness exists, the receipt says fresh supply is unconfirmed; it does
not infer cache reuse. Authoritative investigation can restore a terminal result
without a new model turn, so it remains unconfirmed without a narrow turn witness.
Receipt statements never assert that the model followed or verified instructions.
Existing incomplete-review status and coverage remain authoritative.

Receipt paths and mentions are escaped, rows are bounded, and omitted rows are
counted. The block enters the canonical projection before publication hashes are
computed. If field or overall publication limits prevent it fitting, a compact
notice replaces it. If even that notice cannot fit, the original valid review is
retained and the same closed notice appears in Actions. Legacy and explicit empty
captures without configured sources retain their existing output bytes.

## Correcting repository Skill errors

Invalid repository Skills fail before review inference and cache reuse. The
workflow's actual Actions failure summary identifies the closed failure code,
trusted base, source path, field or referenced path where known, and a correction.
For example, a missing Markdown reference identifies its source `SKILL.md` and
relative target. Invalid UTF-8, nonregular files, unsupported frontmatter,
reference traversal/cycles/depth, and size limits have specific guidance. Reports
never include YAML values/bodies, Git stderr, raw parser exceptions or credentials.

The default Account Gateway failure route reports this in Actions; it does not
post an additional PR failure advisory. No additional publication credentials or
permissions are introduced. Successful review receipts use the existing App
publication route.

## OCR rules and agent integrations

OCR accepts `--rule <path>` for a JSON review-rule file, `--background` / `-b`
for inline business context, and `--background-file` / `-B` for Markdown business
context. The file takes precedence when both background flags are supplied.
Neither the pinned upstream v1.13.1 nor the inspected current upstream has a
`--skill` / `--skills` flag or an automatic project `SKILL.md` loader.

Ordinary upstream OCR resolves the first matching entry from `--rule`, the
repository-root `.opencodereview/rule.json`, the user's global rule file, then
embedded language rules. It does not automatically read `AGENTS.md` / `agent.md`
or inherit instructions from corresponding subdirectories. A JSON rule can
explicitly supply Markdown instructions; that is different from loading an
executable Agent Skill. Managed ReviewRouter suppresses the checkout's project
rule file and supplies its captured, composed rules through `--rule` instead.

The upstream `skills/open-code-review/SKILL.md` is a wrapper loaded by a host
coding agent, which then invokes the OCR CLI. It does not add project-Skill
discovery to the OCR engine. ReviewRouter's opt-in roots below are its explicit,
text-only repository integration; web assignments retain their own path scopes.

Sources checked on 2026-10-21: upstream
[`shared_flags.go` at pinned `8eb83340`](https://github.com/alibaba/open-code-review/blob/8eb83340a487b1150af00701b94f01af97e4b4d6/cmd/opencodereview/shared_flags.go),
[`system_rules.go` at current `375f64cd`](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/internal/config/rules/system_rules.go),
the [review-rule guide](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/pages/src/content/docs/en/review-rules.md),
and the [host-agent Skill guide](https://github.com/alibaba/open-code-review/blob/375f64cd6f67a48a135da83cfcf59c52669a09cb/pages/src/content/docs/en/integrations/agent-skill.md).
The qualified rr.4 binary's `review --help` confirms these flags. Its version and
digest remain recorded in the qualification manifest below.

## Repository Skills subset

Repository managers can opt in to `.reviewrouter/skills` and/or `.agents/skills`.
Only immediate `<root>/<name>/SKILL.md` entries are discovered. Git Skills apply
to all reviewable files; custom path scopes belong to web bindings in v1.

Each Skill starts with YAML frontmatter containing nonblank string `name` and
`description`. Optional keys are `license`, `compatibility`, and a string-to-string
`metadata` map. Unknown keys, execution-required fields (`allowed-tools`, `tools`,
`scripts`, `dependencies`), custom YAML tags, anchors and aliases are rejected.
The remaining Markdown must be nonblank. Scripts and other executable resources
are never executed or installed.

References supported for materialization are `[text](relative.md)` and explicit
reference-style links (`[text][id]` or `[id][]`) with `[id]: relative.md`
definitions. Used shortcut links (`[id]`) to local Markdown are rejected; unused
definitions and links inside backtick or tilde code fences are inert. An optional
`#anchor` is accepted. Local paths cannot contain spaces, URL encoding or an optional
Markdown title. They must resolve inside the originating Skill directory and
are read from the same captured commit. External URLs and document anchors remain
plain text and trigger no network request. Unsupported local resource syntax,
missing references, cycles, traversal, symlinks or Git links fail explicitly.

Limits are 32 combined web/Git Skills, 32 KiB per Skill, eight references per Skill,
16 KiB per reference, four reference levels and a 256 KiB materialized bundle.
Tree enumeration is cumulatively bounded to 1 MiB and 4096 entries per selected
Git root across Skill discovery and Markdown-reference traversal. Separate roots
have independent budgets. Skill counts are checked before loading bodies. Limits
never cause silent truncation.

## Offline qualification

`tools/ocr/build.sh` pins the upstream commit, Go toolchain and compatibility patch
set. `tools/ocr/qualifications/review-skills-v1.manifest` records the reproducible
rr.4 build. Build the binary before the required CLI gate:

```sh
tools/ocr/build.sh --source /path/to/open-code-review --out /tmp/qualified-ocr
REVIEWROUTER_OCR_REQUIRED=1 \
REVIEWROUTER_OCR_BINARY=/tmp/qualified-ocr/opencodereview \
  npx jest __tests__/integration/ocr-managed/ocr-managed-real-cli.test.ts --runInBand
```

The synthetic Git/loopback Responses test checks actual main and plan request
content, merged built-ins, two applicable Skills, case-distinct paths and excluded
inventory. It also materializes a Git Skill from the captured base and projects
the accepted output through the receipt collector into the canonical production
publication. An unwitnessed replay cannot claim fresh supply. It uses
deterministic local responses, with no paid model calls.
`REVIEWROUTER_OCR_REQUIRED=1` makes a missing binary fail instead of skipping.

The runtime CI installs Go 1.26.9 through an immutable `actions/setup-go` pin,
builds rr.4 under `RUNNER_TEMP`, and compares its complete manifest with the
checked-in qualification manifest, including the Linux amd64 binary digest.
Its ordinary full Jest step receives the absolute binary path and
`REVIEWROUTER_OCR_REQUIRED=1`, so the real CLI suite runs once and cannot silently
skip. The upstream checkout, build output and temporary files stay outside the
repository; qualification does not change tracked artifacts.

Focused unit tests cover exact-base Git bodies and resources, scope projection,
bounded transport, native prompt parity, missing supporting inputs and unchanged
historical hashes. Run the generated contract/handoff parity gate in the paired
control-plane repository when changing the published language.

Production registration, release assets, stable tags and deployment use the
existing release process after qualification. A local build does not move a
production channel.
