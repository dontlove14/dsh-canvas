# ADR-0071：共享创作服务、Agent 预设与控制权

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-30。

状态：已采纳
记录日期：2026-10-30

0.2.90 的 [ADR-0073](0073-native-canvas-plan-detail-preview.md) 更正下述方案展示 ID：实际工具等待保留 `wait.callId`，展示 intent 不带 `callId`，使用原生临时全文预览。旧版展示 ID 会误入仅支持 `exit_plan_mode` 的原生历史索引；本次不承诺插件方案永久历史或问题跨重启恢复。

0.2.89 的操作呈现、独立窗口导航、真实视野与只读输入检视由 [ADR-0072](0072-agent-presentation-navigation-and-readonly-inspection.md) 补充。以下版本历史保留；当前窗口观察不再依赖模型选择器，SSE 与回执接入仅负责呈现，不改变本 ADR 的媒体 / 控制机制。

## 背景与驱动因素

用户确认实现通用媒体创作 Agent，支持普通用户纯对话、熟练用户画布操作、资产前置与按需专业分工。现有画布、任务、素材、凭据和存量数据库结构必须兼容；人工接管后不能接受迟到写入或重复付费提交。

1. 复用真实媒体服务和持久任务身份，不引入重复扣费路径。
2. 保持存量画布结构、限制专业写入，并支持同步撤权和安全恢复。

| 驱动因素 | 约束与理由 |
| --- | --- |
| 原有媒体能力 | 图片、视频、FishTTS 继续使用 CanvasService 和持久任务队列，避免第二套协议与凭据 |
| 上下文与权限 | 主 Agent 负责实际写入，独立专业 Agent 只返回草稿，避免专业长文本和写入权限扩散 |
| 控制权 | 先同步撤销 epoch，再取消实际 Agent 和子运行；数据库提交前重新检查身份、epoch 和取消信号 |
| 兼容与恢复 | 创作控制、版本、草稿、委派回执保存在独立 sidecar，不更改 CanvasGraph 或主库 DDL |

## 决策

插件 Bundle 提供 `canvas-creator`「无限画布」（0.2.84 原名「通用创作」，0.2.85 为「视频创作」，0.2.88 依用户要求更名）及 story / assets / shots / audio / review 五个内部专业预设。使用 Harness 原生 legacy `ask_user_question` 和独立上下文 `spawn`；专业委派最多一层、同画布并发最多 2 个，主级核对结果并提交。内部专业预设不允许作为根会话启动。

0.2.85 按用户要求从用户模式目录移除五个内部预设。当前 SDK 预设没有原生隐藏字段，在 Host 对公开 `remoteExportList` 添加可卸载包装，只过滤精确的五个内部 ID；原生 `list` / `resolve` / `mount`、子 Agent 的 `startActivation`、默认预设和其他插件预设保持。Harness 原生模式菜单与设置页消费同一目录，过滤后只新增「视频创作」一个选择项。名称变化只涉及展示与提示，`canvas-creator` 和历史会话身份不变。卸载时恢复原方法，HTTP/Typert 转发保持原协议与权限。

0.2.86 新增主级 `canvas_review_plan`，直接使用官方 UserQuestions 服务的 `detail` 与 `intent.kind="plan-review"`，完整 Markdown、真实 Agent、signal 和日志调用 ID 送原生卡片 / 详情面板。当前 legacy `ask_user_question` 的工具 schema 没有透传 detail / intent，因此保留它处理普通问题，用专用新增工具承接方案审阅，不修改 SDK。原生 UI 要求恰好一题、单选、最多两个选项且 approve 精确命中；插件固定「确认方案 / 需要修改」。只有纯确认才返回 approved=true，混合文本意见不算通过；返回前再次检查取消和 epoch。审阅可在无画布时进行，等待期间新绑定画布则拒绝旧确认；不自动生成、不缓存批准，不将其变成通用写入授权。

同轮修复模型选择器的晚注册与子插槽重复声明：声明存在时原生组件未必已注册；同时另一次 register 不能重复声明它的 label 子插槽。通过公开 `slots/changed` 同步事件与 `entries` 获取 label 声明者，仅可卸载装饰其 component；保留原注入、locale、children、原生 renderSlot 授权和优先级，普通预设继续用原组件。原生重新注册时重新装饰，卸载只恢复仍属于本适配的组件。此公开记录适配受 SDK 升级影响，需原生 SlotCore 专项及加载核验，未来原生策略钩子可替换。

0.2.87 用户明确要求不修改 Harness 原对话模型 select 样式。撤掉创作模式的自定义 select 及全部对应 CSS，两个模式都直接渲染原组件，传入同一 directory / load / select / locale / renderSlot，不改模型目录或操作外观。组件装饰仅观察会话并自动打开关联画布，卸载通过外部订阅立即停止观察。资格校验沿用 Host 的原生选择请求与实际 Agent 请求边界，原生错误 Toast 提示不合格模型；不再宣称客户端选项被禁用。

0.2.88 用户进一步要求保留原模型菜单并禁用非多模态项，主入口更名「无限画布」。当前 SDK 没有模型行禁用扩展字段，因此沿原 label slot 渲染标签，附加隐藏定位锚点，只修改同一原生菜单按钮的 disabled / title / ARIA，使用 Harness 原生禁用样式。title 精确为「非多模态模型，当前 Agent 不支持使用」，能力未核验或读取失败另给暂禁提示。MutationObserver 防止原 busy 写回解除限制；菜单局部捕获鼠标与搜索 Enter / Tab，方向键跳过禁用行，不改目录和标签。普通预设或卸载恢复原属性，能力按 provider / model 精确匹配，菜单重开与目录变更时去重刷新，丢弃旧会话的迟到读取。Host 资格 guard 保留。真实 SDK ModelSelect DOM 专项检查禁用、键盘与卸载；primitive 壳替身不代表主题或悬浮视觉验收。此适配依赖原生 role 和标签结构，SDK 升级须复核。

顶部原生 Toast 默认在两主题都深色；按用户要求，通过精准 body portal（role=alert、原生 --dsh-toast-hold）局部映射表面、文字、业务操作色和边框 token，不修改依赖 CSS，不使用构建散列类。原定时、动效、图标和操作保留；黑白切换的最终视觉结果由用户验收。

Host 单份 CanvasService 上提供 `canvasAgent` 服务，负责控制权、序列化提交、实际 Agent 身份校验、幂等回执、模型资格与子运行取消。Agent 通过受限工具调用服务，不使用 HTTP 伪装调用身份，不开放终端、通用文件系统、SQL、浏览器或子级付费生成。

手动连线与 Agent 引用共用 `shared/referenceConnection` 的素材归属、MIME、模型能力、数量与视频模式校验，避免 Agent 绕过客户端输入限制；节点工厂同样统一，节点移动通过已有 position 字段提交。

工具表使用 Zod 执行校验，导出的 JSON Schema 先去除非枚举 `~standard` 元数据，再交给 Harness。工具限制安装在实际 Agent scope，确保预设作用域提供的工具是可限制的继承项；`structured_output` 由 SDK 在子 Agent 自有 scope 注册，保留其终态机制。预设级执行 guard 进一步拦截未开放能力。

`agent-ledger.json` 由现有 Store 进程锁的同一 Host 独占，使用 0600 原子替换。版本化简报、资产规格、分镜、镜头计划、音频计划、审查记录引用明确草稿 ID 和真实 assetId；更新资产规格时不修改历史版本，依赖旧版本的记录标记 `needsReview`。回执有容量上限，失败时关闭新写入，不静默清除付费身份。

控制和提交队列共用 Host 提交入口。人工 POST 被控制权拦截，观察期间前端不保存视口或编辑画布；用户接管后才开放手动操作。提交前的 epoch 复核阻断异步校验后的迟到写入。生成请求先持久登记归属，再调用现有任务服务；运行时在外发前复核。已经开始的供应商请求、轮询和结果保存继续由 Host 持有，人工接管不重提或丢弃外部任务身份。宿主重启默认回到人工模式，未发送的旧 Agent 任务不再自动发送。

人工重新委托前先保存本地草稿，提供当前 revision。交接基线保留画布快照，后续提供节点、提示词、参数、认可结果和引用变化的有界事实文本，不推测用户意图。其他标签页的未保存草稿继续保留，发生冲突需人工导出或处理，不能覆盖服务器新状态。

模型资格来自 Harness 精确模型元数据的 `inputModalities`，必须明确包含 image，缺失视为不合格。0.2.87 完整保留原选择器，由 SessionController 模型选择入口和实际 Agent 请求校验。当前 SDK 没有选择前策略钩子，因此使用可卸载的公开方法包装，保持普通预设行为；必须在真实 Harness 装载专项中确认该边界。图片使用原生持久附件传入模型。视频与音频目前只有元数据和用户反馈，不声称完整观看、聆听、剪辑、混音或成片合成。

原生 `structured_output` 只接受类型 / 枚举 / 对象 / 数组等 Schema 子集，长度和数量限额在返回后用 Zod 再校验。空白会话切换预设时解除前一预设的工具限制，首次执行重新建立真实身份；专业预设即使通过空白切换进入也必须验证主级父 Agent。

## 边界、交互与负责人

| 上下文 | 数据与职责 | 相邻关系 / 转换 | 检查责任 |
| --- | --- | --- | --- |
| CanvasService | 原画布、素材、模型、持久任务 | 与控制服务共享内核；Agent 参数转成现有服务输入 | `tests/service.test.ts`、`npm run check` |
| CanvasAgentCoordinator | 控制、资格、提交归属、子运行 | 上游原生 Agent；下游 CanvasService；用真实身份与 epoch 适配 | `tests/agent.test.ts` |
| AgentLedger | 独立草稿与版本、幂等及交接基线 | 不承担媒体字节和凭据；不改主库 | 维护者；sidecar 备份 / 恢复 |
| 主 / 专业 Agent | 对话、专业结构化草稿 | 主级与子级客户 / 供应者；独立 scope 与上下文 | SDK 隔离装载专项 |
| Client | 会话对应画布、只读观察、接管与模型选择 | 与 Host 共享公共契约；绑定 Session 的侧栏导航 | `tests/sidebarCanvas.test.tsx`、用户手动验收 |

工具提交和控制指令采用短请求 / 响应；媒体任务异步队列沿用现有轮询。Client 复用 2 秒画布刷新及 1 秒会话导航观察，后台页暂停；不为本地单用户增加事件基础设施。后续高频并发或多用户部署可替换导航通知与 sidecar。

## 备选方案

| 方案 | 未采用原因 |
| --- | --- |
| 一个 Agent 挂全部导演技能并直接读写主库 | 上下文冗余、缺少实际身份和接管边界，破坏兼容与任务幂等 |
| 独立创作后台、重复媒体任务系统 | 增加服务维护和凭据 / 费用状态不一致风险，当前无独立扩容需求 |
| 将 Agent 字段加到 CanvasGraph 或主库 | 无必要，并违反存量画布结构约束 |
| 暂不接入 | 用户已确认实际实现，单靠架构文档不能提供协作工作流 |

## 后果

正面：媒体服务复用、旧数据兼容、权限可测试、专业上下文独立、交接与版本可追溯。

负面：增加独立持久文件和 SDK 接入边界；预设目录隐藏和模型选择策略需要维护公开方法适配，SDK提供原生扩展点后需重审。没有多模态模型时需要用户配置，不降级为文字模型。长视频仍需人工验收、外部剪辑与声音后期。

## 可逆性与重审条件

这是可逆的模块边界选择：移除 Bundle 预设和控制服务可恢复纯手动工作流；回退旧插件保留 sidecar。故障先备份 `agent-ledger.json`，检查记录或恢复其可用备份，不删除主画布 / 凭据 / 任务。若多进程、数据容量、实时导航负载或 SDK 新策略 API 出现，应重审 sidecar 与方法包装，迁移成本限定在 Agent 模块，不迁移媒体 / 画布主库。

## 验证与证据

实现入口：[控制服务](../../src/host/agent/coordinator.ts)、[预设与工具](../../src/host/agent/preset.ts)、[独立持久记录](../../src/host/agent/ledger.ts)、[权限与幂等专项](../../tests/agent.test.ts)。真实 Harness 0.2.1-rc.2 的 Loader / AgentLoop / preset registry / spawn 和原生提问已完成隔离离线核验，使用替身模型返回结构化草稿，不调用收费供应商；记录见[验证记录](../verification.md)。

原生接入依据：[官方子代理子系统](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/subagent)。插件 `canvas_specialist` 使用 `ctx.subagents.startActivation`、provider `spawn`、独立 agentPreset、maxDepth=1、outputSchema 与 delivery=`caller`；主工具等待 `activation.result` 后将结构化草稿作为工具结果交回主 Agent，不额外注入重复父消息。目录适配专项检验精确过滤 / 其他插件保留 / 原结果不变 / 卸载恢复，并在真实 SDK 中确认隐藏后仍可完成 spawn。

方案接入依据：[官方 UserQuestions 子系统](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/user-questions)，已核对本机 0.2.1-rc.2 服务、原生 planReviewOf 和详情面板识别条件。专项使用真实 UserQuestionService 与作用域应答 waterfall 验证 Markdown / 调用身份 / 意见 / 取消 / 接管，真实 SlotCore 验证声明早于组件、原注入与标签授权、卸载恢复。没有浏览器验收或真实收费请求。

| 性质 | 规则 / 阈值 | 证据与频率 | 失败处理 |
| --- | --- | --- | --- |
| 依赖方向 | 专业子级没有写入、付费、再次委派、根提问和终端工具 | `tests/agent.test.ts`；每轮检查 | 不发布失败候选 |
| 契约兼容 | CanvasGraph 字段与主库 DDL 不变；三入口共享节点工厂 | `tests/agent.test.ts`、`tests/nodeCreation.test.ts`；每轮 | 恢复兼容实现 |
| 控制隔离 | 接管同步撤权；异步校验后提交 guard 必须拒绝旧 epoch | 接管 / 迟到专项；每轮 | 不安装 |
| 幂等与容量 | 同操作不重复；子级最多 2 并发 / 深度 1；草稿 10000 / 回执 20000 上限 | 业务专项与源码检查；每轮 | 拒绝新任务，不清除原回执 |
| 恢复 | 重启回人工；已外发继续轮询 / 保存，未外发拒绝 | 恢复专项、加载核验；发布时 | 旧包回退，保留数据与外部身份 |
| 模型边界 | 选择与实际请求都须明确 image 输入能力 | 模型专项、真实 SDK 装载；发布时 | 禁用选项、配置引导 |
| 交互预算 | 导航 1 秒、图状态 2 秒刷新；隐藏页停止观察，不同步等待长媒体任务 | Client 专项；每轮 | 修复刷新与提交队列 |

主要风险是供应商提交中的不确定结果、跨标签页草稿冲突、SDK 方法包装及专业草稿未经真实素材验证。分别由既有任务身份 / 不自动重提、保留草稿与版本冲突、隔离 SDK 装载、事实 / 能力边界与人工验收约束处理。自动化检查不能宣称真实创作质量或人工视觉验收通过。
