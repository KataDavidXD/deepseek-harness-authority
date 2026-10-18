# Authority runtime source snapshot

Snapshot identifier: `authority-source-0.1.0-dev`. This identifier describes this repository's development source distribution. The root package retains the inherited `0.1.0-rc.7` package version; the Python SDK retains its source-checkout version. Neither identifies a new npm or PyPI release.

This repository is an independent source distribution derived from the publicly available DeepSeek Harness source baseline `47f943859bef60e4160492346772ded9b24f765a`. It preserves upstream copyright, [MIT licensing](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md), and [vendored Cordis provenance](vendor/README.md). It is not an official DeepSeek release.

## Supported extension

The SDK/JSON-RPC extension admits a durable attempt before dispatch and exposes `session/attempt.binding`, `session/attempt.start`, `session/attempt.get`, and `session/attempt.cancel`. Receipts bind the exact session, attempt, input digest, durable message identity, persistence instance, and root configuration. Retrying an identical admitted request is idempotent; reusing its identity with different content is rejected.

The runtime owns execution and its event log. An external authority layer interprets the receipts and controls effects. A durable receipt does not authorize a publication by itself, and receipt lookup does not imply checkpoint rewind.

Runtime correctness fixes in this source include waiting for Loader readiness during initialization, retaining tool guards across the operation they protect, and using the correct POSIX `flock` foreign-function signature.

## Build and check

Use Node `^22.19.0` or `>=24.0.0` and the package-manager version in [package.json](package.json):

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm exec vitest run packages/sdk/server/tests/attempt.spec.ts packages/sdk/server/tests/plugin-apply.spec.ts packages/sdk/client/tests/sdk-client.spec.ts packages/session/session-persistence/tests/ownership.spec.ts packages/core/tools/tests/scoped.spec.ts
```

The Python SDK is under [python/sdk](python/sdk). Source development and runtime packaging are described in [python/development.md](python/development.md). Model-backed examples require credentials configured locally. The focused tests above run without provider access.

This is a cleaned source snapshot, not the original commit of any recorded experiment. Historical revisions, environment captures, model-response archives, and experiment datasets are not part of this source distribution. A result can be reproduced only with the separately specified experiment revision, inputs, and environment.
