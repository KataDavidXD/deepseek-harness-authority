# @deepseek-ai/dsh-sdk-client

English | [中文](README.zh.md)

The TypeScript client SDK for driving a DeepSeek Harness runtime as a subprocess over stdio JSON-RPC — the design twin of the [Python SDK](../../../python/README.md) (`deepseek-harness`), sharing the same runtime peer, protocol, and layering: `DeepSeekHarness` is the high-level owned-run API, `HarnessClient` the lower-level protocol client. The package root enumerates the consumer interface: the two client layers, caller-facing types, and `JsonRpcResponseError`; source modules, normalization helpers, and subscription-delivery machinery are not consumer imports. A pure library: it registers nothing on a Cordis context; the runtime process it spawns is a complete harness whose composition its own `cordis.yml` decides.

Unlike the Python SDK, the launch spec is fully explicit (`command`/`args`): this package is for repo-adjacent TypeScript consumers — including the [`dsh-subagent-dsh-sdk`](../../subagent/subagent-dsh-sdk/README.md) backend and automation — that know which runtime they are launching. Bundled-runtime resolution (finding a packaged executable) remains the Python distribution's concern.

## DeepSeekHarness

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

await using harness = new DeepSeekHarness({
  launch: { command: 'node', args: ['lib/bin.js', 'cordis.yml'] },
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  maxTokens: 49_152,
})
const result = await harness.run('say hi')
console.log(result.finalResponse)
```

The subprocess starts lazily on first use and stays owned by the instance across `run()` calls; `close()` (or `await using`) is required so the child is always reaped. `start()` memoizes the `initialize` handshake (the workspace cwd — resolved absolute before it crosses the wire — plus the provider/model route and optional positive `maxTokens` output cap); a failed handshake reaps the runtime and swaps in a fresh client, and a later operation also atomically replaces a subprocess that died after initialization. `getRuntimeBinding()` performs only start+initialize (no prompt), returns the immutable path-free schema-2 store-and-root envelope, and pins it across replacement subprocesses; another persistence UUID or exact root-config digest raises `RuntimeBindingMismatchError` before durable work. The root digest covers the once-read root-file bytes, not startup patches, provider/model, environment-derived values, plugin modules, or external state; a broader fence remains operator-owned. The cap applies to each root-agent request and is inherited by in-process descendants; compaction plugins own their separate summary limits. `session(id?)` opens a named or fresh session handle.

`run(input, { sessionId?, onNotification? })` retains the legacy activity-interval behavior: it queues the prompt, waits until its `MessageId` appears in an `agent/inbox/spliced` receipt, then collects through the next whole-agent `idle`. The result now also exposes that `messageId`, `deduplicated: false`, and the interval's last `finishReason` when present. Its `finalResponse` is still the last committed root-session assistant text in the interval, not a response causally assigned to the prompt; steering, injected context, and other queued work may contribute before idle.

For restart-safe orchestration, pass `attemptId` and `inputSha256` together:

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

await using harness = new DeepSeekHarness({
  launch: { command: 'node', args: ['lib/bin.js', 'cordis.yml'] },
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
})
const result = await harness.run('apply the change', {
  sessionId: 'deployment-owned-session',
  attemptId: 'wtb-attempt-17',
  inputSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
})
```

This uses `session/attempt.start`. An already-terminal deduplicated attempt returns immediately without waiting for notifications. For queued/running receipts, the SDK polls exact `session/attempt.get` state every `attemptPollIntervalMs` (default 1000 ms); a root idle notification triggers an immediate extra poll but is never required for progress or treated as outcome proof. Only the exact terminal receipt supplies `finalResponse`, `finishReason`, `terminalEventSeq`, and `turn`. `attemptTimeoutMs` is one overall deadline from start dispatch through polling (default 300000 ms). Expiry raises `AttemptTimeoutError` and never cancels the runtime-owned attempt; callers can subsequently use `getAttempt()` or explicitly `cancelAttempt()`. A missing field, unknown status, or mismatched session/attempt/input identity is a protocol error. `getAttempt()` and `cancelAttempt()` are available on both `DeepSeekHarness` and `HarnessSession`.

## HarnessClient

The protocol client under the owned-run API: explicit `start()`/`initialize()`/`prompt()`/`startAttempt()`/`getAttempt()`/`cancelAttempt()`/`request()`/`close()`, plus notification subscriptions. `prompt()` remains the compatibility receipt-to-idle primitive. The three attempt methods speak `session/attempt.start|get|cancel`, validate every echoed ownership field and status, and preserve JSON-RPC conflicts as `JsonRpcResponseError`. `subscribe(filter?)` returns a `NotificationSubscription` (awaitable `next()`, bounded and waiter-safe `nextWithin()`, non-blocking `tryNext()`, async iteration); `subscribeSessionTree(id)` scopes to one session and the descendants discovered from `subagent.started` lineage edges — the runtime notifies for every session in its context, and scoping is client-side, exactly like the Python SDK. Error surfaces are typed and exported from this package: `JsonRpcResponseError` (wire error response, code/data preserved), `RequestTimeoutError` (a configured request bound elapsed), `AttemptTimeoutError` (terminal proof missed the high-level run deadline without cancellation), `RuntimeBindingMismatchError` (a replacement process or receipt names another store), `SdkProtocolError` (a response outside the documented protocol), and `TransportClosedError` (the runtime is gone — message carries the exit code and a bounded stderr tail).

`close()` requests protocol `shutdown` (bounded by `shutdownTimeoutMs`, default 1000 ms), then walks a stdin-EOF → SIGTERM → SIGKILL ladder (`disposeEofGraceMs` default 6000, `disposeGraceMs` default 3000) until the process has actually exited. The ladder is private to this client: it runs outside any harness context, so it cannot ride the [`dsh-subprocess`](../../subprocess/README.md) service — the seam's documented exception for SDK-managed transports. It is idempotent, and a closed client refuses reuse.

`HarnessClientOptions.env` replaces the child environment entirely when given (`undefined` inherits the parent's); callers own credential policy — `scrubbedParentEnv` from `dsh-subprocess` is the shared scrub base for isolation-minded launches.

## Model Experience

None, as this is a client-process library; the model runs in the spawned runtime, whose experience is owned by the plugins its `cordis.yml` composes.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No bundled-runtime resolution** — callers name the runtime executable explicitly; packaged-executable discovery stays Python-side until a TypeScript distribution consumer exists.
- **Legacy prompts remain interval-scoped** — `prompt()` and `run()` without an attempt identity intentionally keep receipt-to-idle semantics. Use the paired `attemptId`/`inputSha256` path when an operator needs durable per-attempt proof or cancellation.
- **Durable attempt methods require a compatible persistent runtime composition** — an older runtime rejects the new method before dispatch; a runtime without durable attempt support returns a JSON-RPC error rather than silently falling back to `session/prompt`.
- **Client→server notifications and server→client requests are unimplemented** on both wire ends; the transport carries them for future approval flows.
