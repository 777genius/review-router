# Review Skills — runtime delivery

Status: implementation and local runtime qualification complete, paired with [SaaS PR #635](https://github.com/777genius/review-router-ai/pull/635). Remote CI status is reported separately in the PR; local qualification is not a deployment claim.

The authoritative implementation plan and three-round review log live in the SaaS repository at `ai-docs/plans/2026-10-21-review-skills.md` and `ai-docs/plans/2026-10-21-review-skills-reviews.md`.

## Runtime scope

- [x] Consume an explicitly versioned, immutable, run-authorized Skills envelope; preserve legacy absent-extension behavior.
- [x] Resolve explicitly enabled Git Skills and bounded Markdown references from the captured trusted base commit, without sending repository file bodies to the control plane.
- [x] Feed the same engine-neutral per-path instructions to managed OCR and the native reviewer, including investigation prompts and prepared entrypoints.
- [x] Correct OCR's generated rules to its actual parser; qualify exact case-sensitive paths and an assigned-file allowlist with the patched real binary.
- [x] Include Skills in incremental compatibility and invocation identity, preserving historical hash preimages.
- [x] Verify real OCR requests against loopback Responses, native parity, trusted Git resolution, bounds, capability negotiation, and generated contract parity.

## Qualified identities and delivery

- `ocr-managed-v3`: managed `1.13.1-rr.4`, upstream commit `8eb83340a487b1150af00701b94f01af97e4b4d6`, ten pinned patches, Go `1.26.9`.
- Linux amd64 binary SHA256: `0553daafe39d7a9d7608f0d37b26d55c11d07b9d5bbfc5b36b0778f9cd9f3df5`; exact build receipt in `tools/ocr/qualifications/review-skills-v1.manifest`.
- Native supporting profile: `codex-skills-v1`, retaining the verified Codex `0.147.0` binary.
- Published source export: SaaS `35ec3863c62b13095efdcc0083a180cea7ad6eba`; handoff digest `af9020733c465e66d748b6b80da57e148e3fe0622231d29e829bf98b5ca1aca1`.
- Gateway OCR/native and verified direct OpenRouter delivery are supported. Older Secrets/Hosted callers retain legacy profiles and refuse new admissions with assigned Skills; this does not silently omit instructions.

## Executed verification

The complete commands and shared acceptance evidence are maintained in the paired SaaS implementation report. These local runtime results were observed:

| Verification                                              | Result                                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Required real OCR CLI against loopback Responses          | 10/10 passed, main and plan prompts inspected                                                       |
| Skills unit plus repeated required CLI after final export | 21/21 passed                                                                                        |
| Independent Skills/native/OCR adapter review              | 52/52 passed; no remaining P0/P1 in the reviewed scope                                              |
| Full runtime lint and typecheck                           | Passed; lint has 0 errors and 398 existing warnings                                                 |
| Normal Action and CLI build                               | Passed; committed generated bundles refreshed                                                       |
| Context gateway artifact                                  | Unchanged SHA256 `37f54bbd18d5348221e4d4bad29eaa455e1f97fd4372ea9ba07ad42358425d2e`                 |
| Paired signed API to runtime HTTP proof                   | Passed in SaaS: scope, retained old capture, changed new-run cache identity and forged-token denial |
| Existing direct OpenRouter paired regression              | 2/2 passed in SaaS                                                                                  |
| Paired lifecycle and committed production artifact        | 58/58 passed, with explicit retained legacy and Skills profile identities                           |
| Direct-provider setup and approved-profile selection      | 45/45 passed                                                                                        |
| All three failures found by the full remote Jest run      | 49/49 passed together after fixes: artifact smoke, setup preview and workflow audit                 |

The ordinary runtime CI now builds the pinned OCR binary in its temporary directory, compares the complete manifest, and sets `REVIEWROUTER_OCR_REQUIRED=1` on its existing Jest run. A missing binary cannot silently skip that suite.

The remote run on `4aae5bd` exposed three stale regression assumptions: a single approved Codex profile/digest occurrence, the old direct-provider profile selection, and the new pinned `actions/setup-go` missing from the exact audit table. The corrections retain both profile identities, require Skills capability for the supporting route, and audit exactly one use of setup-go `b7ad1dad31e06c5925ef5d2fc7ad053ef454303e` with Go `1.26.9` and cache disabled. All three affected files passed together locally; the latest complete remote run remains a separate check.

The [user/runtime documentation](../../docs/review-skills.md) defines the supported Markdown subset and limits. No paid model request was needed for deterministic qualification. A supplied prompt is evidence of delivery, not proof that a model complied with every instruction.

Stable release tags, production profile registration, published release assets and deployment remain part of the existing release process after these PRs are reviewed.

## Requested follow-up review

An independent GPT-6.1 Sol xhigh critic found one introduced P2: a used shortcut
Markdown reference could silently omit a required local checklist. The bounded
v1 parser now rejects that form explicitly while preserving supported explicit
links, unused definitions, external/anchor references and code examples. A
second critic independently reviewed the fix and found no blocker or expansion
of file/network/tool authority. The inline finding and fix remain recorded in
PR #297 under the repository owner's connected account.

After this correction and the official handoff refresh, the focused Skills,
generated-contract and rebuilt production-artifact batch passed **16/16**.
The full typecheck, changed-file lint/format check and normal Action/CLI build
passed. The OCR source, patches, qualified binary and context-gateway artifact
were unchanged, so this follow-up did not rebuild or requalify Go unnecessarily.
The preceding complete remote CI run on historical `13b66b2` passed; new-head
remote CI is a separate result shown on the PR.

The owner requested their own commit attribution. Feature-branch author and
committer metadata were corrected while preserving each committed source tree;
the previous source SHA in historical qualification evidence therefore remains
a historical observation. The handoff above was regenerated by the SaaS export
command from the new reachable source commit; generated content was not edited
by hand.

The OCR CLI and current upstream were also inspected for the user's question.
The supported integration is `--rule`; `--background-file` supplies business
context. OCR's distributed `SKILL.md` is a host-agent wrapper. Native project
Skill discovery and directory-scoped `AGENTS.md` inheritance are not implemented
by the inspected engine. [The runtime guide](../../docs/review-skills.md#ocr-rules-and-agent-integrations)
records the exact inspected sources and separates this from ReviewRouter's
explicit opt-in Git roots. No automatic agent-instruction loader was added.

Main subsequently advanced to `b4d8bd5676841b5a1967618bab460a5046bcbf30`
(compact review comments, version 1.0.189). It was merged into this branch;
the only conflict was `dist/index.js.map`, resolved by the normal build from
both source sets. An independent GPT-6.1 Sol xhigh critic confirmed byte-for-byte
retention of main-owned output files and premerge Skills files, and matched 13
relevant source-map entries to disk. Full typecheck and the combined Skills,
contract, artifact and reviewer-summary batch passed **77/77**. The paired
SaaS signed-HTTP test also passed against this merged runtime. Its first
attempt stopped in fixture reset with SQLSTATE 53100 because the shared disk
was full; the successful repeat followed cleanup of our reproducible caches
and compression of our stopped TEST databases with complete backups retained.
