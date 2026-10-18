# Agent Note: Hermetic SDK runtime deployment

Status: implemented

English | [中文](2026-08-14-hermetic-sdk-runtime-deploy.zh.md)

## Problem

The single-executable builder used pnpm's legacy deploy implementation with a hoisted linker. That implementation installed part of the closure beside the deploy source under `python/sdk-runtime/node_modules`, so a successful artifact build could change the workspace install topology. A later source launch then failed on packages such as `eventsource-parser`, even though the packaged carrier booted. Restoring that directory in `finally` would still expose the mutation to concurrent work and would not survive process termination or power loss.

## Decision

The builder uses modern `pnpm deploy` with `--config.inject-workspace-packages=true`, `--config.node-linker=hoisted`, and the lockfile's existing peer-install policy. Modern deploy derives a dedicated lockfile and installs the complete closure only below a same-volume temporary target. The hoisted target is already link-free and keeps one physical `@deepseek-ai/cordis`; the builder still rejects any residual link, rejects zero or multiple Cordis instances, and runs `pnpm peers check` against the staged target before packaging. It starts both the TypeScript source bin and the staged node-carrier entry before packaging, then promotes the completed node carrier to its final directory. Promotion first moves the prior carrier to a backup and restores it if the final rename fails; a rollback failure preserves that backup and reports its path.

Modern deploy identifies an injected workspace dependency by a checkout-specific absolute `file:` locator, which cannot have a portable positive `allowBuilds` entry. `pnpm-workspace.yaml` therefore records `@deepseek-ai/dsh-subprocess-local: false`, and the builder explicitly runs that package's reviewed `ensure-spawn-helper.mjs` from the isolated staging after deployment. Other reviewed dependency builds, including `node-pty` and `koffi`, remain controlled by their existing positive entries. On Windows the builder invokes pnpm through its JavaScript entry because current Node releases reject direct `.cmd` spawning without a shell.

## Verification

`pnpm run test:build-hermeticity` has fast command and rollback-contract tests plus a serial real-deploy test. The real test snapshots every workspace-owned `node_modules` topology without following package links, deploys into a temporary target, requires the snapshot to remain byte-for-byte identical, and then starts both the TypeScript source bin and the staged node carrier's `packaged-bin.js` entry over real stdio JSON-RPC. Both carriers must answer sequential `initialize` and `shutdown` requests before publication, and the published node carrier is started again. Production build code separately enforces the staged link, Cordis-identity, and peer-graph invariants. This gate does not invoke `pkg --sea`; actual SEA executables remain covered by the supported-platform executable and wheel build workflows.

## Alternatives considered

**Legacy deploy plus rename and `finally` restoration.** Rejected because the shared workspace is still missing or replaced during the build, concurrent tests can observe that state, and abrupt process death bypasses `finally`.

**A copied temporary workspace with live-source junctions.** This is a viable fallback for a package manager without isolated deploy, but it duplicates workspace discovery, introduces realpath and junction behavior into the artifact boundary, and is unnecessary once modern deploy succeeds against the committed lockfile.

**Modern deploy with the isolated linker followed by recursive link materialization.** Rejected because peer links initially converge on one Cordis instance, while recursively copying each link creates multiple physical Cordis copies. The modern hoisted linker produces a link-free, single-instance target directly.

**Disabling strict dependency-build review for deploy.** Rejected because it turns an unreviewed lifecycle script into a warning. The shipped route records an explicit denial and runs only the one reviewed staging operation under builder control.

## Consequences

Artifact construction no longer mutates, temporarily replaces, or repairs the source install tree, and a failed pre-publication build leaves the prior node carrier in place. Source and staged-node execution can be tested after the same build, while concurrent workspace work does not depend on cleanup. The dedicated target lock follows the repository lock's peer policy while explicit workspace-peer closure verification and staged peer checking keep the runtime graph reviewable.

The builder now owns one explicit lifecycle operation that pnpm would otherwise run for the local subprocess package, and the build test performs a real production deployment rather than a mock. That gate is intentionally serial and slower than a unit test, but it detects the package-manager behavior that caused the original corruption.
