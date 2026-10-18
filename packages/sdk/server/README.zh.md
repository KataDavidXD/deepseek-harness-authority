# @deepseek-ai/dsh-sdk-jsonrpc-server

[English](README.md) | 中文

`jsonrpc` 插件通过 stdio 提供以换行符分隔的 JSON-RPC，使进程外 SDK 客户端能够驱动 harness agent（智能体）。[`HarnessSdkJsonRpcServer`](src/server.ts) 负责协议方法和通知；传输与具名协议类型位于 [`dsh-sdk-protocol`](../protocol/README.md)，与客户端 SDK 共享；[`jsonrpc-demo`](../../examples/jsonrpc-demo/README.md) 提供外围的 `cordis.yml` 应用。

## 组装

`inject: ['agents']`。服务器按 `sessionId` 获取或创建一个 agent。legacy `session/prompt` 无需持久化即可使用。持久 attempt 查询要求 `sessionPersistence`；start 与 cancel 还要求后端支持 ownership，缺失时会在 dispatch 前失败。只有服务对生命周期建立快照时记录的 `local` 标志为 true，服务器才会转发 subagent 完成事件；提供方名称、子级 id 和持久化谱系均不能证明本地性。已注册的适配器优先；尚无适配器负责的 `deepseek-official` 路由会挂载 `dsh-llm-deepseek`，任何其他尚无适配器负责的提供方都会导致初始化失败。其他能力由外围 `cordis.yml` 提供。

## 配置

`maxTokensAsSuccess` 默认为 `false`，且只影响 `subagent.finished` 上由部署映射的状态；根会话提示词没有提示词级状态。`JsonRpcConfig.input`、`output` 和 `exit` 是仅供运行时使用的传输钩子；生产环境使用进程 stdio 和 `process.exit`。

## stdout 即协议

Stdout 只承载 JSON-RPC 帧。部署不得组合 stdout logger；诊断应写入 stderr。

## 关闭与退出语义

插件响应 `shutdown`，刷新响应并 dispose（资源释放）根上下文，使 SDK 持有的 agent、订阅和持久化达到完全停稳，然后以代码 0 退出。EOF 和信号退出由 app bin 处理，后者也会 dispose 根上下文。仅卸载此插件会停止服务，但不会退出进程。

## 协议说明

`initialize.serverInfo.name` 的协议稳定值为 `deepseek-harness-sdk-runtime`。可选的正整数 `initialize.maxTokens` 会成为每个 SDK 创建的 agent 及其进程内后代的请求输出上限；非法值会使初始化失败，省略时则不发送 SDK 上限，并应用所选适配器或提供方路由的默认值。`session/prompt` 将一条带标识的用户消息排入队列，并立即返回 `{ messageId }`。面向事务 operator 时，`session/attempt.start` 会在记录 attempt 身份与同一条 inbox 消息之前安装进程内 delivery gate，先 flush queued 回执，再释放并唤醒它；无论 driver 原本空闲还是正在运行，都不能在 barrier 之前领取该 FIFO。flush 失败会让精确 live 项保持停放，因此相同重试可以在不重复插入的情况下执行 flush、release 与 wake。`session/attempt.get` 折叠 live log 或 `sessionPersistence.readFrom` 返回的物理持久前缀；`start` 会 resume 冷 queued 或 running 回执，让 load 在返回修复后的 terminal 回执之前提交 crash repair。`session/attempt.cancel` 只移除精确 queued 消息及其 gate，或取消其活跃轮次并保留其余 inbox；terminal 回执 flush 后会唤醒这些保留工作。live 回执都在 flush 前捕获，因此响应可以稍旧，但不会声称仅在 barrier 之后出现的事件已经持久。每个 session 的操作串行执行，恢复出的持久 inbox 无需重新插入即可被唤醒，shutdown 会等待已准入操作。服务器将每个持久事实作为 `session.event` 流式发出，并将整个 agent 生命周期的每次状态转换作为 `session.status` 发出。持久化根目录和 persona 由 `cordis.yml` 提供。

配置的持久化后端声明支持 ownership 时，服务端会在创建、恢复或唤醒持久 SDK 会话之前取得独占 session ownership。不支持 ownership 的后端仍兼容 legacy prompt；只读 attempt 查询可以检查其物理日志，而 start 与 cancel 会拒绝这类后端。服务端持有 ownership，直到 agent 停稳、完成最终 flush 与 disposal，随后才释放 ownership。循环领取 SDK-attempt 消息后、模型 dispatch 前，`agent/pre-step` 会断言 ownership 并 flush 已领取的 turn 意图；失败或没有持久化参与方都会阻止 adapter 请求。

初始化会把已配置后端经过校验的规范小写 UUIDv4 与 app boot 的 `rootConfigSha256` 组合成 schema 2 的 `runtimeBinding`；每个持久 attempt 回执都携带同一个不可变 envelope。App boot 对其单次读取后挂载的精确根 Cordis 文件字节计算 hash，而不会让 Loader 再次打开该路径。其权威子树会在实际 Loader pre-apply 边界拒绝嵌套 Include identity、冻结根 Include config，并在初始挂载后封存 child mutation。digest 通过仅限该子树、不可枚举的继承 capability 到达本 server；替代 sibling 不会取得旧 digest，因此不会发出 binding。持久 start/get/cancel 除现有 persistence/ownership 要求外还要求这两个值，因此第三方后端或绕过固定 app boot 的 host 不会发出不完整的 proof。任一能力缺失时，legacy prompt 初始化仍兼容，并省略可选 binding。根配置 digest 不是语义化插件图指纹，也不涵盖启动时 patch 参数、由环境派生的表达式值、插件模块或插件外部状态；任何更宽的部署 manifest 仍由 operator 掌握权威。

## 模型体验

### SDK 用户消息

#### 模型看到的内容

对于每个已接受的 `session/prompt` 或新准入的 `session/attempt.start`，对话模型会将调用方提供的 `contentBlocks` 原样作为该 SDK 会话中的一条用户消息接收。attempt 身份只作为持久 source 元数据，不添加模型可见文本。此包不会添加系统提示词文本或工具 schema；这些内容来自外围 `cordis.yml` 中的插件。

#### Token 影响

依数据而定的用户消息 token 会进入保留的会话历史，并在后续轮次中重复发送，直至另一个包将其压缩（compaction）。JSON-RPC 帧、会话通知和服务器内部记录不会增加模型上下文 token。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **协议没有逐会话关闭或 legacy prompt 取消方法**：只有 `session/attempt.*` 支持带身份 fence 的取消；SDK 创建的 agent 会一直存活到进程关闭。
- **legacy prompt 仍没有逐提示词结果**：`session/prompt` 保留兼容语义；事务客户端应使用 attempt 回执。
- **stdout 纯净性由部署保证**：外围配置仍可能加载 stdout logger 并破坏 JSON-RPC 通道；此插件不会检查或否决同级 logger。
- **自动挂载适配器仅支持 DeepSeek**：`initialize` 可以复用任何预先注册的模型适配器，但唯一的回退行为是挂载 `dsh-llm-deepseek`。
