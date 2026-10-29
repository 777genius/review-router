# Agent Instructions

- Follow the maintained [Engineering Quality Standard](https://github.com/agent-teams-ai/.github/blob/main/docs/engineering-quality-standard.md), within this repository's explicitly adopted scope and pinned toolchain.
- Follow [Review Action v2 development and release](docs/review-action-v2-development.md) for protocol, generated bundles and release gates; preserve its separation between source changes and runtime activation.
- Feature flags: implement features without new flags. Introduce or enable a feature flag only when the user explicitly requests it; immutable protocol capability/version checks remain part of compatibility validation.
