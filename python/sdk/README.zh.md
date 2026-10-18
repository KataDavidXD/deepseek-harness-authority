# DeepSeek Harness Python SDK

[English](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.md) | 中文

通过 JSON-RPC stdio 驱动 DeepSeek Harness 的 Python 子进程 SDK。运行时继承常规的 DeepSeek Harness 环境变量（如 `DEEPSEEK_BASE_URL` 与 `DEEPSEEK_API_KEY`），调用方可以直接使用真实模型端点，也可以把这些变量指向本地代理。

请从 PyPI 安装 `deepseek-harness-sdk` 分发包；导入模块仍为 `deepseek_harness`：

```sh
python -m pip install deepseek-harness-sdk
```

安装 `deepseek-harness-sdk` 会同时安装版本完全相同的 `deepseek-harness-runtime-bin` 平台 wheel 包。因此常规入口不需要传可执行文件参数：

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness() as harness:
    result = harness.run("Say hi.")
```

`DeepSeekHarness` 会保留其按需启动的运行时子进程，以便在多次调用之间复用。若子进程在初始化后死亡，下一次操作会在同一个 SDK 对象上原子启动并初始化替换进程。`get_runtime_binding()` 只执行该握手而不发送 prompt，并返回不含路径且不可变的 schema 2 envelope；其中 `root_config_sha256` 是协议字段 `rootConfigSha256` 的别名，对运行时单次读取后挂载的精确根 Cordis 文件字节计算 hash。固定模式的运行时会在 Loader 的实际 pre-apply 边界拒绝嵌套 Include identity、冻结根 Include config，并在初始挂载后封存其 child tree。digest capability 仅存在于该权威子树，因此移除或替换它不会让 sibling server 取得旧 binding。首次 envelope 会跨进程替换固定，另一存储或根配置 digest 会抛出 `RuntimeBindingMismatchError`。该 digest 不是语义化插件图指纹，也不能证明启动时 patch 参数、由环境派生的表达式值、插件模块或插件外部状态；需要更宽 fence 的 operator 必须自行维护具有权威性的 manifest。请像上例一样将其用作上下文管理器，或在使用完毕后显式调用 `close()`。

在首次 dispatch 前校验部署配置的 operator 可以调用 `get_runtime_process_binding()`，原子捕获 store binding 与不透明的存活子进程 generation。把该 generation 作为 `expected_process_generation` 传给 `run()` 后，SDK 必须使用同一个已运行子进程，并把整个 `Session.run()` 固定到其 client；若该子进程已死亡或发生变化，SDK 会在 `session/attempt.start` 前抛出 `RuntimeGenerationMismatchError`，且不会在这条 fenced 路径上重启。未设置该 fence 的查询与 reconcile 调用仍会自动重启子进程。

默认情况下，SDK 会启动 `deepseek-harness-runtime-bin` 包内置的单文件可执行程序 `dsh-jsonrpc-agent`，并通过 `DSH_CORDIS_CONFIG` 注入该包的默认配置，其中包括 stdio JSON-RPC 服务器、agent core（智能体核心）、预载的 DeepSeek 适配器、采用显式组合语义检查点策略的 JSONL 会话持久化，以及本地 bash。要运行自己的插件组合，请在配置中保留 `@deepseek-ai/dsh-sdk-jsonrpc-server` 配置项，并传入 Cordis 配置文件路径。

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cordis="examples/jsonrpc-agent/cordis.yml",
) as harness:
    result = harness.run("Make the requested code change.")
```

`provider` 选择指定 Cordis 组合所注册的提供方路由；`model` 是该适配器解析出的模型 ID。`max_tokens` 是一个可选的正整数，用于限制根 agent 及其进程内后代在每次请求中输出的 token 数量；省略该参数时，由提供方的默认行为决定输出上限。压缩摘要继续使用压缩插件单独配置的上限。内置默认组合注册 `deepseek-official`。自定义组合可以挂载 `llm-pi-ai`，在其中配置各提供方专属的凭据和端点，并选择 pi-ai 已安装 catalog 中存在的任意提供方/模型组合。

[Python SDK 教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md)提供一套无需使用 Web UI、按步骤完成安装和首次运行的流程。该教程所用的完整独立 Cordis 配置文件位于 [`jsonrpc-agent` 示例](https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/jsonrpc-agent/README.md)中。

不带 attempt 身份的 `Session.run()` 保留兼容的活动区间：从提示词的 inbox 回执开始，到整个 agent 下一次进入空闲状态时结束。`RunResult` 现在还包含 `message_id` 与 `deduplicated=False`；`final_response` 仍是该区间内根会话最后提交的助手文本。`finish_reason` 是该区间内根会话最后一个 `turn/end` 的 `kind`，例如 `completed`、`max-tokens` 或 `error`；没有轮次结束时为 `None`。这些字段描述活动区间，并不表示某项输出或结束原因在因果上归属于该提示词。

operator 需要重启安全时，必须成对传入 `attempt_id` 与 `input_sha256`：

```py
with DeepSeekHarness() as harness:
    result = harness.run(
        "Apply the requested change.",
        session_id="deployment-owned-session",
        attempt_id="wtb-attempt-17",
        input_sha256="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    )
```

持久路径会在 `session/attempt.start` 之前订阅通知。已经终结的去重 attempt 会立即返回，不等待通知。对于 queued/running attempt，SDK 每隔 `attempt_poll_interval_seconds`（默认 1 秒）轮询一次精确的 `session/attempt.get` 状态；根会话 idle 通知只会触发一次额外的立即轮询，既不是推进所必需，也不是结果证明。只有精确匹配的 terminal 回执能提供 `final_response`、`finish_reason`、`terminal_event_seq` 与 `turn`。`attempt_timeout_seconds` 是从 start 调度到轮询结束的统一截止时间（默认 300 秒）。超时抛出 `AttemptTimeoutError`，绝不取消运行时持有的 attempt；调用方随后可以 `get_attempt()`，或显式调用 `cancel_attempt()`。缺失字段、未知状态，或 session/attempt/input 身份不匹配都会抛出 `SdkProtocolError`。`DeepSeekHarness`、`Session` 与底层 `HarnessClient` 均公开 `get_attempt()` 和 `cancel_attempt()`。旧运行时或非持久运行时会在调度前拒绝新方法；SDK 不会静默回退到 `session_prompt()`。

`HarnessClient` 会在运行时进程的整个生命周期内保留已发现的 subagent 谱系。每次执行 `Session.run()` 时，`RunResult.notifications` 与 `on_notification` 会按协议传输顺序收到根会话及所有已知后代的通知，其中包括嵌套 subagent 的生命周期事件与会话事件。`RunResult.events` 只包含根会话事件，因此后代消息不会覆盖根会话回复。底层 `session_prompt()` 保留旧的入队原语；`start_attempt()`、`get_attempt()` 与 `cancel_attempt()` 会校验持久回执及其中回显的所有权字段。`NotificationSubscription.next_with_timeout()` 提供不遗留后台 waiter 的有界等待；关闭订阅会用 `TransportClosedError` 唤醒正在等待的调用。

也可以通过 `DSH_CORDIS_CONFIG` 为运行时子进程指定配置。注入逻辑位于 `HarnessClient.start()`，因此底层客户端按默认方式启动时也具有该行为：如果启动方式最终解析为内置运行时，且既没有设置 `cordis`，也没有设置非空的 `DSH_CORDIS_CONFIG`（运行时将空值视为未设置，注入检查也是如此），系统就会使用内置默认配置；显式指定 `runtime_bin`、`bridge_bin` 或 `launch_args_override` 时，则会完全禁用该注入。运行时载体（生产用 exe 与仅限开发的 `node` 闭包）及其获取方式见 [sdk-runtime README](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk-runtime/README.md)。

`cwd` 与 `runtime_cwd` 会在启动子进程、注入环境变量和协议握手前解析为绝对路径。公开 API 只暴露由 SDK 直接应用的选项：部署 persona 和持久化配置应在 `cordis.yml` 中定义；`session_root` 则保留为设置 `DSH_SESSION_ROOT` 的高层便捷参数。
