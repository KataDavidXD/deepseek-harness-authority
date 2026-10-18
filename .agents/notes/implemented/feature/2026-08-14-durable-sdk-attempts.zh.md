# Agent Note: 持久 SDK attempt

Status: implemented

[English](2026-08-14-durable-sdk-attempts.md) | 中文

## 问题

SDK 的 `session/prompt` 操作接收提示词后，只返回进程内可用的消息 id。外部工作流 operator 可以先持久记录执行意图，再调用 Harness，却无法把该意图绑定到一项持久 Harness 事实。任一进程丢失响应后，operator 无法区分提示词尚未收到、已排队、运行中或已经终止。重试可能创建第二个 turn 并重复工具副作用；拒绝所有重试又可能让从未到达 Harness 的工作永久搁置。客户端的进程内历史在重启后也无法消除这种歧义。

## 决策

JSON-RPC SDK 在旧 prompt 操作旁新增独立的持久 attempt 约定：`session/attempt.start`、`session/attempt.get` 与 `session/attempt.cancel`。attempt 由会话 id、有界的调用方 attempt id、小写 SHA-256 输入指纹以及服务端派生的确定性消息 id 这一精确元组标识。`start` 接收内容块，返回 queued、running 或 terminal 回执以及去重标志。以相同 identity 与内容重复调用时会观察既有 attempt；以不同指纹或内容复用 attempt id 时则快速失败。

attempt identity 保存在由同一个 `agent/inbox/spliced` 插入的持久用户消息 source 中。服务端在允许分发前 flush 这次插入，而不是另写一条可能与 inbox 事实分叉的 attempt 记录。查询从实时会话或持久会话日志重建回执：inbox 投影识别排队工作，被领取的用户消息绑定 turn，`turn/end` 提供终止原因。terminal 回执还携带被领取的 turn、终止事件序号与最终 assistant 文本。会话操作串行执行，因此 start、查询、取消与关闭不会发布彼此矛盾的回执。

通过支持 ownership 的后端管理的每个持久 SDK 会话，都只有一个由后端强制保证的 writer owner。服务端在 create、resume 或 wake 前取得 ownership，并持续持有到 agent 停稳、完成最终 flush 与 agent disposal，随后才释放 ownership。第一方持久化提供方声明该能力，并使用进程崩溃时由内核释放的原生 advisory lock 与持久 fencing generation，因此另一进程不能并发恢复并领取同一个 queued attempt。不声明 ownership 的后端仍可使用 legacy prompt 与只读 attempt 查询，但会拒绝 attempt start 与 cancel；ownership 争用或丢失也会快速失败。SDK attempt 被领取后，`agent/pre-step` 监听器会在委托模型 dispatch 前持久 flush 已领取的 turn 与用户消息意图；该 barrier 不依赖可选的 checkpoint-policy 组合。

恢复持久 agent 时可以选择 `wakePending`。具体循环会先发布重建后的 agent 及其监听器，只有持久 inbox 已含工作时才唤醒驱动器。此操作不会新增消息，因此调用方可以在“持久入队完成、分发尚未开始”的崩溃之后安全地用同一 attempt redrive。旧有恢复行为默认仍不唤醒，除非调用方明确请求该选项。

取消与 identity 绑定。排队中的 attempt 会只移除自己的持久消息，并返回 canceled terminal 回执。运行中的 attempt 会请求协作式用户取消、保留不相关的 inbox 工作、等待完全停稳并 flush，随后返回重建出的 terminal 回执。attempt 不存在、identity 不匹配或已经无法取消时会失败，而不会报告会话日志无法证明的本地取消。

取消原因在成为会话事实前会穿过不受信任的运行时边界。某些运行时会修改对象形式的 `AbortSignal.reason`（Node HTTP 客户端可能添加不可枚举的 `stack` accessor），从而让严格 JSON 持久化拒绝后续 `turn/end`。因此 agent loop 会在持久 append 前把封闭的 `AgentCancelCause` union 快照成全新的纯 JSON record，绝不持久化 adapter 或工具已经观察过的原对象引用。

TypeScript 与 Python 客户端同时暴露三个低层操作及高层 run/get/cancel 方法。高层持久运行会校验返回的每个 identity，默认每秒轮询一次精确 attempt 查询，直至 300 秒的整体截止时间；idle 通知只会提前触发一次轮询。客户端超时只停止等待，绝不取消由 runtime 持有的 attempt。最终结果来自精确 terminal 回执，而不再只依赖全局 idle 观察。旧 prompt API 保持可用，并保留此前的协议格式。

初始化还会公开一个严格的 schema 2 runtime-binding envelope，其中包含 protocol version、schema version、不含路径且采用规范小写形式的 persistence-instance UUIDv4 与 `rootConfigSha256`。JSONL 把该 UUID 原子存储在根身份文件中；SQLite 复用不可变的单例 store id；SDK 服务端会拒绝不符合该 wire-safe UUID 形式的后端值，且不在错误中回显原值。App boot 只读取一次已解析路径所指向的根 Cordis 文件，对这些精确字节计算 hash，并挂载同一次捕获解码出的内容，不让 Loader 再次打开路径。初始 child apply 前，固定模式的 boot 会预导入每个有效启用的插件，跨别名和构建后模块副本识别 Include 与 Group identity，拒绝即使 disabled 的静态 Include 名称、拒绝每个有效启用的 Include identity，并按 Loader 等价规则传播 disabled 状态，因此不会导入 disabled alias 模块。继承的 pre-apply policy 会阻止程序化创建或后续启用 Include；根 Include config 不可变，且其 child tree 在初始挂载后封存。digest 本身是仅限该子树、不可枚举的 capability，因此被移除或替换的根不会把旧 authority 借给 sibling SDK server。已启用插件模块的顶层代码仍可能在预检时运行。每个持久回执都会重复该 envelope。两个 SDK 都会固定首次 binding，在初始化后子进程死亡时原子重启、在不发送 prompt 的情况下重新初始化，并拒绝绑定到另一存储或根配置 digest 的替换进程或回执。`rootConfigSha256` 只证明已挂载的根文件字节，而不是语义化插件图指纹：启动时 patch 参数、由环境派生的表达式值、插件模块字节、在该文件外解析的凭据与插件外部状态均不属于 binding。需要 fence 这些输入的 operator 必须自行掌握具有权威性的 manifest 或 digest。

Python SDK 可以在 operator 校验配置前，把该 binding 与不透明的存活子进程 generation 原子配对。使用已捕获 generation 设 fence 的 run 会在订阅、attempt admission 与 terminal 轮询期间使用同一个既有 client，既不启动也不替换进程；generation 已死亡或不同时，会在 `session/attempt.start` 前失败。未设 fence 的查询仍会自动重启，使恢复流程可以通过替换子进程检查持久状态。

持久化 UUID 标识一条逻辑存储血缘，而不是某个物理副本、新鲜快照或 anti-rollback generation。按设计，复制完整 JSONL 根目录或 SQLite 数据库会保留该值，而复制出的逐会话 ownership lock 保护的是不同物理文件。因此，原存储与副本禁止同时承载持久 attempt。独立 clone 必须先执行 provider 专属的离线 rekey，再进行 single-active cutover；rekey 会改变 binding，但不会让重复 attempt 历史的并发回放变得安全。系统不提供公开的在线 rekey seam 或 SDK 服务端 clone mode，因为二者都无法证明每个物理副本已经停稳。该部署 fence 归 operator 所有。

崩溃修复可能用 `interrupted` 关闭一个已领取但仍开放的 turn。这只能证明精确 attempt 已被领取，且没有记录正常 Harness 完成；它不能证明外部工具副作用已经发生或没有发生。operator 必须保留 recovery fence，并对账该精确 attempt 与工具幂等证据，而不能把 `interrupted` 当成取消或自动重试该副作用。

## 曾考虑的替代方案

不采用给 `session/prompt` 添加可选 attempt 字段，因为旧服务端可能忽略字段，却表现得像接受了持久请求。不采用在 inbox 插入前后另写 attempt 事件，因为两次写入之间的崩溃会重新造成双写歧义。不采用只在 SDK 客户端保存 attempt 回执，因为进程丢失会抹去对账所需证据。不采用进程内 session mutex，因为两个服务端进程仍可恢复并 dispatch 同一个持久 inbox。不采用自动重试未匹配的工具调用，因为执行可能已经到达外部副作用。

不采用操作系统 process id 作为 dispatch fence，因为该 id 可以复用，且会暴露平台专属实现细节。不为设有 generation fence 的 run 自动重启死亡子进程，因为替换进程可能在 operator 校验旧子进程后加载了已变化的 provider 或 Loader 配置。

## 后果

WTB 等 operator 可以持久化 attempt fence，以同一个 identity 调用 Harness，并在任一进程重启后查询或 redrive 该精确 attempt，而不会创建第二个 Harness turn。排队 attempt 在重启后存活，并只由独占 owner 唤醒一次；已完成 attempt 从持久证据返回；identity 冲突、ownership 争用与无法证明的取消都会快速失败。测试覆盖重复 start、冲突回放、排队中与运行中取消、持久 terminal 查询、重启唤醒与崩溃修复、跨 context ownership、dispatch 前的插入与 claim flush、shutdown 释放顺序、路径替换期间同一次捕获的根配置 hash 与挂载、嵌套 Include 别名与 disabled 预检语义、实际 pre-apply identity enforcement、不可变 Include config 与封存 child mutation、子树 digest capability 撤回、对抗性持久化 identity、真实 Loader 组合以及两个 SDK 客户端的协议校验。

该约定为 Harness turn 提供 effect-once 准入，但不是分布式事务。WTB 数据库、Harness 会话日志与任意外部工具无法原子提交。支持幂等的工具提供方可以接收稳定的工具调用 id；无法匹配结果的持久工具调用仍按[语义检查点策略](../bug-fix/2026-07-21-semantic-session-checkpoints.md)标记为 `TOOL_OUTCOME_UNKNOWN`；Harness 不声称通用的外部副作用 exactly-once。

generation fence 有意放弃首次 dispatch 的透明存活性：若已校验的子进程退出，operator 必须重新建立并校验 process binding，才能再次尝试 admission。持久查询仍可重启，因为它既不创建 attempt，也不唤醒非 terminal 工作。

runtime binding 同样不提供 freshness 或 anti-rollback 证明。恢复较旧的存储快照，或从另一物理路径运行复制出的同一血缘，都可能呈现相同 binding；operator 必须在 Harness 外部 fence 备份恢复、副本提升与 clone cutover。
