# Fork notes: OAuth composition

This fork (branch `oauth-composition`) makes native compaction work together with
[`@gotgenes/pi-anthropic-auth`](https://www.npmjs.com/package/@gotgenes/pi-anthropic-auth),
i.e. with a Claude subscription (OAuth) instead of an API key. Upstream 0.0.11 replaces the
`anthropic` provider's `streamSimple` with Pi's bare Anthropic adapter, which bypasses the
auth extension's request shaping; ordinary turns then fail with HTTP 400.

## Change

- `extensions/anthropic-compat/runtime.ts`: at `session_start`, after every extension has
  registered, resolve the transport already registered for `anthropic` and delegate to it.
  Native request serialization uses the same delegate. Templates and request boundaries are
  recorded at the delegate's final `fetch` (only for accepted requests); signed checkpoints are
  replayed there too, keeping opaque blocks intact.
- `extensions/anthropic-compat/transport.ts`: `finalizeRequest()` moves replay `betas` into
  the `anthropic-beta` header and keeps the original authentication, signal and headers.
- `test/oauth-composition.test.ts`: offline tests (both load orders, auxiliary calls, opaque
  replay, beta header, abort, reinitialization, API-key pass-through, rejected turns, failed
  summary, automatic threshold compaction). Set `PI_ANTHROPIC_AUTH_ENTRY` to the auth
  extension's `src/index.ts`; without it those tests are skipped.

No change to credentials, token refresh, the model allowlist, native validation or the
fail-closed behavior.

## Live validation (Pi 1.2.0, pi-anthropic-auth 3.4.2, OAuth subscription, full-history mode)

| Model             | Manual `/compact` | Automatic, threshold | Automatic, context overflow + retry |
| ----------------- | ----------------- | -------------------- | ----------------------------------- |
| claude-opus-5-5   | ✅                | ✅                   | ✅                                  |
| claude-sonnet-5-5 | –                 | ✅                   | ✅                                  |
| claude-haiku-5-5  | –                 | ✅                   | ✅                                  |
| claude-opus-4-8   | –                 | ✅                   | –                                   |
| claude-sonnet-4-6 | –                 | ✅                   | –                                   |

Each run: a real `read` tool call, a signed native checkpoint, replay of the signed checkpoint
on later turns (HTTP 200) and recall of facts that only lived in the compacted history; the
threshold runs compacted three times in a row on top of earlier checkpoints. The threshold was
forced low through Pi's `compaction.reserveTokens`; the overflow runs answered one request with
a synthetic "prompt is too long" 400 so Pi took its compact-and-retry path.

Observed: when compaction happens in the middle of a tool loop (or before an overflow retry),
the continuation request has no user text left, so the auth extension adds no billing header to
it. Anthropic answered those requests with 200 in every run; turns started by a new user
message carry the header again.

Not live-tested: retained-tail mode (`keepRecentTokens` > 0), branch navigation, a provider
replaced again after `session_start`.
