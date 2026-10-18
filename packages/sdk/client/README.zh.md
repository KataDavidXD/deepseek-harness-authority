# @deepseek-ai/dsh-sdk-client

[English](README.md) | 中文

以子进程方式驱动 DeepSeek Harness 运行时、走 stdio JSON-RPC 的 TypeScript 客户端 SDK——[Python SDK](../../../python/README.md)（`deepseek-harness`）的设计孪生，共享同一个运行时对端、协议与分层：`DeepSeekHarness` 是高层自有运行 API，`HarnessClient` 是低层协议客户端。包（package）根枚举消费方接口：两层客户端、面向调用方的类型和 `JsonRpcResponseError`；源模块、规范化辅助函数与订阅投递机制不供消费方导入。纯库：不在任何 Cordis 上下文注册；它所 spawn 的运行时进程是一个完整 harness，其组成由自己的 `cordis.yml` 决定。

与 Python SDK 不同，启动规格完全显式（`command`/`args`）：本包面向仓库近旁的 TypeScript 消费方，包括 [`dsh-subagent-dsh-sdk`](../../subagent/subagent-dsh-sdk/README.md) 后端和自动化；它们知道自己要启动哪个运行时。捆绑运行时解析（寻找打包可执行文件）仍归 Python 发行版负责。

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

子进程在首次使用时惰性启动，并在多次 `run()` 之间持续归实例所有；必须 `close()`（或 `await using`），子进程才总能被回收。`start()` 记忆化 `initialize` 握手（工作区 cwd——在通过协议传输之前解析为绝对路径——加 provider/model 路由和可选的正整数 `maxTokens` 输出上限）；握手失败会回收运行时并换入全新客户端，初始化后死亡的子进程也会在下一次操作中被原子替换。`getRuntimeBinding()` 只执行 start+initialize（不发送 prompt），返回不含路径且不可变的 schema 2 存储与根配置 envelope，并跨替换进程固定该值；另一 persistence UUID 或精确根配置 digest 会在持久工作前抛出 `RuntimeBindingMismatchError`。根 digest 只覆盖单次读取的根文件字节，不覆盖启动时 patch、provider/model、环境派生值、插件模块或外部状态；更宽的 fence 仍由 operator 单独持有。该上限作用于根 agent（智能体）的每次请求，并由进程内后代继承；压缩（compaction）插件单独持有摘要上限。`session(id?)` 打开具名或全新的会话句柄。

`run(input, { sessionId?, onNotification? })` 保留兼容的活动区间语义：它将提示词排入队列，等待其 `MessageId` 出现在持久的 `agent/inbox/spliced` 回执中，然后持续收集到整个 agent 下一次进入 `idle`。结果现在还包含 `messageId`、`deduplicated: false`，以及存在时该区间最后一个 `finishReason`。`finalResponse` 仍是该区间内根会话最后提交的助手文本，并非因果上归属于该提示词的响应；steering（中途引导）、注入的上下文和其他排队工作都可能在 idle 前参与其中。

需要重启安全的编排时，必须成对传入 `attemptId` 与 `inputSha256`：

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

这条路径使用 `session/attempt.start`。已经终结的去重 attempt 会立即返回，不等待通知。对于 queued/running 回执，SDK 每隔 `attemptPollIntervalMs`（默认 1000 毫秒）轮询一次精确的 `session/attempt.get` 状态；根会话 idle 通知只会触发一次额外的立即轮询，既不是推进所必需，也不是结果证明。只有精确匹配的 terminal 回执能提供 `finalResponse`、`finishReason`、`terminalEventSeq` 与 `turn`。`attemptTimeoutMs` 是从 start 调度到轮询结束的统一截止时间（默认 300000 毫秒）。超时抛出 `AttemptTimeoutError`，绝不取消运行时持有的 attempt；调用方随后可以 `getAttempt()`，或显式调用 `cancelAttempt()`。缺失字段、未知状态，或 session/attempt/input 身份不匹配都属于协议错误。`DeepSeekHarness` 与 `HarnessSession` 均公开 `getAttempt()` 和 `cancelAttempt()`。

## HarnessClient

自有运行 API 之下的协议客户端：显式 `start()`/`initialize()`/`prompt()`/`startAttempt()`/`getAttempt()`/`cancelAttempt()`/`request()`/`close()`，外加通知订阅。`prompt()` 保留兼容的回执到 idle 原语。三个 attempt 方法分别调用 `session/attempt.start|get|cancel`，校验所有回显的所有权字段与状态，并将 JSON-RPC 冲突保留为 `JsonRpcResponseError`。`subscribe(filter?)` 返回 `NotificationSubscription`（可等待的 `next()`、有界且不遗留 waiter 的 `nextWithin()`、非阻塞 `tryNext()`、异步迭代）；`subscribeSessionTree(id)` 把范围限定到一个会话及从 `subagent.started` 血缘边发现的后代——运行时对上下文内每个会话都发通知，范围限定在客户端完成，与 Python SDK 完全一致。本包导出有明确类型的错误：`JsonRpcResponseError`（协议错误响应，保留 code/data）、`RequestTimeoutError`（请求时限已到）、`AttemptTimeoutError`（高层 run 未在截止时间前得到 terminal 证明，但没有取消 attempt）、`RuntimeBindingMismatchError`（替换进程或回执指向另一存储）、`SdkProtocolError`（响应超出文档化协议）以及 `TransportClosedError`（运行时已消失——消息携带退出码与有界 stderr 尾部）。

`close()` 先请求协议 `shutdown`（受 `shutdownTimeoutMs` 约束，默认 1000 毫秒），然后走 stdin-EOF → SIGTERM → SIGKILL 阶梯（`disposeEofGraceMs` 默认 6000，`disposeGraceMs` 默认 3000）直到进程真正退出。该阶梯为本客户端私有：它运行在任何 harness 上下文之外，无法搭乘 [`dsh-subprocess`](../../subprocess/README.md) 服务——即该 seam 所记录的 SDK 托管传输例外。幂等，已关闭的客户端拒绝复用。

`HarnessClientOptions.env` 给定时整体替换子进程环境（`undefined` 原样继承父进程环境）；凭据策略归调用方——`dsh-subprocess` 的 `scrubbedParentEnv` 是面向隔离启动的共享擦除基底。

## 模型体验

无，因为这是一个客户端进程库；模型运行在 spawn 出的运行时中，其体验由该运行时的 `cordis.yml` 所组合的插件决定。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **无捆绑运行时解析**——调用方显式指定运行时可执行文件；打包可执行文件的发现留在 Python 侧，直到出现 TypeScript 发行版消费方。
- **旧提示词仍按区间归属**——不带 attempt 身份的 `prompt()` 与 `run()` 有意保留从回执到 idle 的语义。operator 需要持久的逐 attempt 证明或取消时，应使用成对的 `attemptId`/`inputSha256` 路径。
- **持久 attempt 方法要求兼容的持久化运行时组合**——旧运行时会在调度前拒绝新方法；不支持持久 attempt 的运行时返回 JSON-RPC 错误，SDK 不会静默回退到 `session/prompt`。
- **客户端→服务端通知与服务端→客户端请求**在协议两端都未实现；传输层为未来审批流保留了承载能力。
