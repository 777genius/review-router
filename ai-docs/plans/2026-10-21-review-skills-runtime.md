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
- Published source export: SaaS `e8d083c20c9cb2a8a0262842940538afec636088`; handoff digest `df098a0fdd988f56388a1cb613d122592e80a43ce14ed08590c3f91256243620`.
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
