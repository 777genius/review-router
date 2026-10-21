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
with explicit path labels. Skills grant no additional tools, commands, network
access or file scope. Provenance means the instructions were supplied; it does
not certify that a model performed each requested check.

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

References supported for materialization are `[text](relative.md)` and used
reference-style links with `[id]: relative.md` definitions. An optional `#anchor`
is accepted. Local paths cannot contain spaces, URL encoding or an optional
Markdown title. They must resolve inside the originating Skill directory and
are read from the same captured commit. External URLs and document anchors remain
plain text and trigger no network request. Unsupported local resource syntax,
missing references, cycles, traversal, symlinks or Git links fail explicitly.

Limits are 32 combined web/Git Skills, 32 KiB per Skill, eight references per Skill,
16 KiB per reference, four reference levels and a 256 KiB materialized bundle.
Tree enumeration is bounded to 1 MiB and 4096 entries per tree; Skill counts are
checked before loading bodies. Limits never cause silent truncation.

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
inventory. It uses deterministic local responses, with no paid model calls.
`REVIEWROUTER_OCR_REQUIRED=1` makes a missing binary fail instead of skipping.

Focused unit tests cover exact-base Git bodies and resources, scope projection,
bounded transport, native prompt parity, missing supporting inputs and unchanged
historical hashes. Run the generated contract/handoff parity gate in the paired
control-plane repository when changing the published language.

Production registration, release assets, stable tags and deployment use the
existing release process after qualification. A local build does not move a
production channel.
