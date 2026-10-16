# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Compose with an Anthropic OAuth transport registered by another extension, such as
  `@gotgenes/pi-anthropic-auth` for Claude subscriptions. At session start the extension now
  delegates to the transport already registered for `anthropic` instead of replacing it with the
  bare Anthropic adapter, which had dropped the subscription request shaping and made ordinary
  turns fail with HTTP 400. Request templates and checkpoint replay apply at the delegate's final
  `fetch`, after all shaping, and replay beta flags are moved into the `anthropic-beta` header
  while the request's authentication, signal and other headers are kept. Restarting the session
  unwraps the extension's own earlier wrapper instead of nesting it.

## [0.0.11] - 2026-10-15

### Changed

- Require Pi `>=1.2.0 <1.3.0`.

### Fixed

- Full-history compaction no longer fails with "Too many strict tools" or another strict
  tool limit while Pi's turns succeed through its non-strict retry. It sends
  `strict: "prefer"` tools non-strict after such a turn and retries a rejected summary request
  once without them, as Pi does. With **Native tail tokens** set, these sessions compact the full
  history and show a warning, because retained messages cannot replay behind the changed tools.
- Record the system instructions, tools, and request boundary only for the request Anthropic
  accepted. A turn Pi retried no longer records the rejected attempt as well.

## [0.0.10] - 2026-10-08

### Added

- Native full-history and retained-message compaction for Claude Haiku 5.5
  through the direct Claude API. The live model capability check still applies.

### Changed

- Require Pi `>=1.1.0 <1.2.0`. Restart Pi after upgrading its runtime.
  If the last compaction kept recent messages, set Native tail tokens to `0`
  and compact the full conversation before upgrading Pi.

## [0.0.9] - 2026-10-02

### Changed

- Require Pi 1.0.0 or newer. Restart Pi after upgrading its runtime.
  If the last compaction kept recent messages, set Native tail tokens to `0`
  and compact the full conversation before upgrading Pi. Changes to prompt text
  and tool declarations can invalidate retained history, even when thinking is off.

## [0.0.8] - 2026-10-01

### Fixed

- Declare the tools the turns sent in native compaction under Pi codemode's
  `only` mode. Summary requests rebuilt the tools from the transcript, which
  still lists the tools codemode hides from turn requests. Full-history
  summaries missed the prompt cache, and keep-tail compaction always cancelled.
- Resume sessions whose saved `/anthropic-settings` values include a setting a later
  version removed or no longer accepts. Those fields are skipped instead of failing
  the whole record at session start.

### Changed

- Require Pi 0.99.1 or newer. The extension refuses to load on an older Pi.

## [0.0.7] - 2026-09-30

### Added

- Native on-demand compaction and retained-message replay for
  `claude-sonnet-5-5`. Sonnet 5.5 requires Pi 0.99.1's model catalog.

### Changed

- Validate releases against Pi 0.99.1. Pi 0.87.0 and newer remain supported.

## [0.0.6] - 2026-09-25

### Fixed

- Separate menu sections with blank rows, using compact spacing on short terminals.
- Align setting names on the left and values in a stable column on the right.
  Render the search placeholder in muted gray instead of ordinary input text.
  Keep Save and Discard hints visible in narrow terminals.
- Align settings with the Codex menu: Enter changes values, Ctrl+S saves and
  applies drafts, and Escape discards unapplied drafts. Search no longer prevents
  changing settings.
- Save only changed overrides, preserve inheritance and external edits, and
  report conflicting saves without overwriting them.

### Added

- Apply to session without changing configuration files. Reopening settings shows
  active session values, including after reload, restart, or resume.
  Ctrl+S can save session-only changes later.
- Numeric editors with presets and custom values, configuration-source labels,
  inherited-value resets, and keyboard, focus, and mouse support.

## [0.0.5] - 2026-09-23

### Added

- Native compaction and retained-history replay for Claude Opus 5.5 on Pi 0.87.1.

## [0.0.4] - 2026-09-23

### Changed

- Clarify Pi runtime selection and system-prompt patcher configuration in the packaged documentation.
  Native compaction and retained-history replay behavior are unchanged.

## [0.0.3] - 2026-09-22

### Changed

- Require Pi 0.87.0 or newer and validate against Pi 0.87.0.
- Respect Pi's message omissions and replacements when selecting recent messages to retain.

### Fixed

- Preserve mid-conversation prompt and tool updates during retained-history replay on Pi 0.87.

## [0.0.2] - 2026-09-20

### Fixed

- Load under an installed Pi package by importing the Anthropic Messages adapter through the `@earendil-works/pi-ai/compat` entry that Pi resolves for extensions, instead of an unresolvable `api/` subpath.

## [0.0.1] - 2026-09-20

### Added

- Native on-demand Anthropic compaction for manual and automatic Pi compaction on Pi 0.86.0 or newer.
- Persistent signed-summary replay, full session-history retention, and compaction usage accounting.
- Searchable `/anthropic-settings` menu with session changes, explicit saves, and discard controls.
- Trusted project configuration, cancellation, and concurrent session/configuration change protection.
- Configurable native tail retention with verified request boundaries, exact thinking replay, and resume/fork support.
- Strict thinking-prefix enforcement for retained history and a live Fable 5.1 low-effort test with rejection controls.
- Live packaged-CLI test that exercises native compaction, replay, and resume through the shipped Pi executable.

[Unreleased]: https://github.com/2h2d-co/pi-anthropic-compat/compare/v0.0.9...HEAD
[0.0.9]: https://github.com/2h2d-co/pi-anthropic-compat/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/2h2d-co/pi-anthropic-compat/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/2h2d-co/pi-anthropic-compat/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/2h2d-co/pi-anthropic-compat/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/2h2d-co/pi-anthropic-compat/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/2h2d-co/pi-anthropic-compat/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/2h2d-co/pi-anthropic-compat/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/2h2d-co/pi-anthropic-compat/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/2h2d-co/pi-anthropic-compat/releases/tag/v0.0.1
