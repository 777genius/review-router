# Gateway reviewer execution

Status: implemented in the Action runtime; release activation follows the
existing producer registration boundary.

The owning implementation plan and review ledger are maintained in
[ReviewRouter's multi-reviewer plan](https://github.com/777genius/review-router-ai/blob/feat/gateway-multi-reviewers/ai-docs/plans/2026-10-28-gateway-multi-reviewers.md),
tracked by [ReviewRouter #738](https://github.com/777genius/review-router-ai/pull/738).
Do not duplicate its domain decisions in this runtime repository.

This companion delivery extends the existing Action orchestration to several
server-admitted Gateway reviewers. Each reviewer retains its exact vote identity,
model/settings and isolated native session. One parent run owns durable
coordination, cancellation, aggregate projection and publication. The existing
work-slot, evidence, consensus and publication contracts remain their semantic
owners.

The later mixed Gateway and GitHub Secrets/direct scenario extends reviewer
session composition. It is outside this delivery. No feature flag, universal
executor framework, alternate publication pipeline or paid inference replay is
introduced.

Canonical shared contracts are exported from committed ReviewRouter source with
the existing tooling. Generated files and runtime bundles must be rebuilt and
qualified as described in [Action v2 development](review-action-v2-development.md).
Source changes, producer registration and deployment remain separate operations.
