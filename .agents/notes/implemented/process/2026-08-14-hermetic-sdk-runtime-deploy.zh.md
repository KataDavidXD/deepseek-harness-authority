# Agent Note: SDK 运行时的密封部署

Status: implemented

[English](2026-08-14-hermetic-sdk-runtime-deploy.md) | 中文

## 问题

单文件可执行程序构建器曾将 pnpm 的 legacy deploy 实现与 hoisted linker 配合使用。该实现会把部分闭包安装到部署源旁的 `python/sdk-runtime/node_modules` 下，因此即使产物构建成功，也可能改变工作区安装拓扑。后续源代码启动会因 `eventsource-parser` 等包缺失而失败，尽管已打包载体仍可启动。在 `finally` 中恢复该目录仍会让并行工作观察到变更，而且无法应对进程终止或断电。

## 决策

构建器改用 modern `pnpm deploy`，传入 `--config.inject-workspace-packages=true`、`--config.node-linker=hoisted`，并沿用锁文件中既有的对等依赖安装策略。Modern deploy 会派生专用锁文件，并仅在同一卷的临时目标下安装完整闭包。Hoisted 目标本身已经没有链接，并且只保留一个物理 `@deepseek-ai/cordis`；构建器仍会拒绝任何残余链接、拒绝 Cordis 实例为零或多个的情况，并在打包前对暂存目标运行 `pnpm peers check`。它会在打包前同时启动 TypeScript 源码 bin 与暂存 node 载体入口，然后才把已完成的 node 载体提升到最终目录。提升操作会先把旧载体移到备份；如果最终 rename 失败，就恢复旧载体；如果回滚也失败，则保留该备份并报告其路径。

Modern deploy 使用与检出路径相关的绝对 `file:` locator 标识注入的工作区依赖，因此无法为它编写可移植的正向 `allowBuilds` 条目。`pnpm-workspace.yaml` 因而记录 `@deepseek-ai/dsh-subprocess-local: false`，构建器则在部署完成后，从隔离的暂存目录显式运行该包中已审查的 `ensure-spawn-helper.mjs`。其他已审查的依赖构建（包括 `node-pty` 和 `koffi`）继续由既有的正向条目控制。在 Windows 上，构建器通过 pnpm 的 JavaScript 入口调用它，因为当前 Node 版本拒绝在不使用 shell 的情况下直接 spawn `.cmd`。

## 验证

`pnpm run test:build-hermeticity` 包含快速的命令约定和回滚约定测试，以及串行的真实部署测试。真实测试会在不跟随包链接的前提下，为工作区拥有的每棵 `node_modules` 拍摄拓扑快照，部署到临时目标，要求前后快照逐字节相同，然后通过真实 stdio JSON-RPC 分别启动 TypeScript 源码 bin 与暂存 node 载体的 `packaged-bin.js` 入口。两个载体都必须在发布前依次响应 `initialize` 和 `shutdown` 请求，已发布的 node 载体随后还会再次启动。生产构建代码会独立强制暂存目录的链接、Cordis 身份与对等依赖图不变量。该门禁不会调用 `pkg --sea`；实际 SEA 可执行文件继续由支持平台上的可执行文件与 wheel 包构建工作流覆盖。

## 曾考虑的替代方案

**Legacy deploy 加 rename 和 `finally` 恢复。** 否决原因是构建期间共享工作区仍会缺失或被替换，并行测试可以观察到该状态，而且进程突然终止会绕过 `finally`。

**复制临时工作区，并用 junction 指向实时源码。** 对于没有隔离部署能力的包管理器，这是可行的后备方案；但它会重复工作区发现逻辑，把 realpath 和 junction 行为引入产物边界，而且 modern deploy 能够基于已提交锁文件成功运行后就不再需要它。

**使用 isolated linker 的 modern deploy，再递归物化链接。** 否决原因是对等依赖链接最初会收敛到同一个 Cordis 实例，而递归复制每个链接会产生多个物理 Cordis 副本。Modern hoisted linker 可以直接生成无链接的单实例目标。

**为部署关闭严格依赖构建审查。** 否决原因是这会把未经审查的生命周期脚本降级成警告。交付方案会记录显式拒绝，并且只在构建器控制下运行一项已审查的暂存操作。

## 后果

产物构建不再修改、临时替换或修复源安装树，而且发布前构建失败时会保留旧 node 载体。同一次构建后可以同时测试源码与暂存 node 载体，并行的工作区任务也不再依赖清理逻辑。专用目标锁沿用仓库锁文件的对等依赖策略，而显式的工作区对等依赖闭包验证和暂存对等依赖检查让运行时依赖图保持可审查。

构建器现在需要接管一项 pnpm 原本会为本地子进程包运行的显式生命周期操作，而构建测试会执行真实生产部署，不使用 mock。该门禁有意串行执行，速度慢于单元测试，但能够检测导致原始污染的包管理器行为。
