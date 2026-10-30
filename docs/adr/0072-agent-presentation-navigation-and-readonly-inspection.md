# ADR-0072：Agent 操作呈现、原生窗口导航与只读检视

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-30。

状态：已采纳
记录日期：2026-10-30

## 背景与驱动因素

用户批准[可见协作方案](../proposals/agent-visible-canvas-collaboration-v0.1.md)两个批次，要求 Agent 操作可被察觉，未打开工作区时自动打开，已打开时进入正确画布；只读仍应能查看提示词。本决策补充 ADR-0071 的呈现边界，原媒体、控制权和任务机制保持。

1. 无返回的窗口方法调用不代表内容已经显示；晚挂载、同目标导航和切会话必须核验身份。
2. 只读限制写入，保留阅读、复制、历史与引用预览；自动布局必须来自实际视野或诚实说明后备来源。

## 决策

Host `AgentPresentation` 在独立 0600 原子文件 `agent-presentation.json` 保存每张画布最新呈现意图与固定布局起点。视野、前台 presence 和回执仅在内存保存，有效期 5 秒；视野按 viewId / sequence 拒绝乱序。意图携带 sessionId / canvasId / epoch / graphRevision / nodeIds / action / taskId，时间跨画布单调递增。接管立即使旧 epoch 无效，重启沿原控制机制回人工，不复活旧指令。

插件根生命周期监听 Harness 当前 mounted 会话、原 Connection.reset；SSE 发送真实提交后的意图，一秒读取最新状态作补偿，图状态原两秒刷新保持，意图到达即时刷新。模型包装只处理资格，窗口不依赖选择器或标签挂载。首次使用公开 `sidebarRight.openTab`；已有标签使用公开 `tabDomain.navigate` 更新 params / revision，随后展开并 focus 原标签。真实 SDK 验证表明 tabActions.openTab 会将浮窗页另开到停靠区，因此不用于复用路径。原布局、其他标签和模型选择器保持。

客户端登记目标画布已载入、可见的 seat；未载入不标记打开完成。目录晚返回持续补偿，切目标前 await 原 flush；有未保存冲突时保留草稿，不强制进入。异步全过程校验会话、意图、epoch 和可见性。用户退回列表、关闭已到达标签或主动浏览暂停该 session / canvas / epoch 跟随，sessionStorage 保留暂停；恢复只展示最新意图，接管才撤销写权。

React Flow 根据已展开容器的 screenToFlowPosition 计算中心和实际节点尺寸。首节点扣半宽高；后续从固定起点按资产 / 镜头 / 音频分组，支持相关节点锚点，预留标题、端点、媒体和 530px 提示词区域，只移动新节点。无有效视野返回 saved-viewport / existing-node 等实际来源，不冒称视野中心。显式 position 保留兼容。

节点原卡片呈现无写回调的当前输入；原生成历史 / 本次任务使用归属验证后的冻结快照，引用可预览，提示词可复制。恢复历史覆写、生成、任务动作、图写入和上传在 Agent 期间禁用。当前选中和视角只在浏览器，不持久为共享图改动。

关键工具提交完成后，在提交队列外等待呈现。对应图版本、节点和只读卡片已真实渲染且在容器内才报告 presented；用户暂停返回 paused，无前台、8 秒超时、更新替代或宿主关闭返回 deferred。呈现等待可被取消 / 接管唤醒，不无限阻塞、不重新执行操作。回执是程序证据，不能代替人工视觉验收。

| 模块 | 职责 / 边界 | 检查 |
| --- | --- | --- |
| AgentPresentation / Coordinator | 身份、最新意图、临时报告、等待与自动放置；不改主库 / CanvasGraph | agent / agentPresentation 专项 |
| 插件根 observer / nativeCanvasNavigation | 当前会话原生导航、晚挂载、已有标签复用；不提供通用窗口工具 | canvasPresentation / nativeCanvasNavigation |
| useCanvasPresentation / CanvasApp | 实际容器测量、图版本、DOM 回执、跟随与草稿保护 | canvasPresentationRender / sidebarCanvas |
| 输入与快照检视 | 无写回调阅读、复制、引用预览与任务归属 | nodeInspection / historyInspection |

## 备选方案

| 方案 | 取舍 |
| --- | --- |
| 模型选择器内加长轮询、调用后即记成功 | 生命周期与原生无执行路径仍存在，不能核验窗口 |
| Agent 每次自行调用通用窗口工具 | 可能漏调且扩大权限；不采用 |
| 独立呈现意图、原生导航与真实回执 | 已采用，限制窗口影响并核对实际内容，增加少量状态与往返 |

## 后果

正面：操作可见、只读可阅读、首节点位置可解释，保留原窗口布局与媒体身份。

负面：增加一个独立文件、事件流与每步最多 8 秒等待。极窄窗口不能同时完整容纳节点与卡片时不会伪报 presented；用户浏览暂停后中间步骤不重放，最新状态保留。

## 可逆性与重审条件

退回已核验 0.2.88 包时保留两个 Agent sidecar、原配置与两库；旧版忽略新呈现文件，无数据库迁移。若 Harness 提供官方呈现服务、原生导航契约改变、多窗口或高频协作需求出现，应重审适配与事件输送。故障先备份并检查文件 / API / epoch；不得删除原媒体或任务、不得重提交费生成恢复。

## 验证与证据

入口：[Host 呈现](../../src/host/agent/presentation.ts)、[原生导航](../../src/client/nativeCanvasNavigation.ts)、[视野与回执](../../src/client/useCanvasPresentation.ts)、[只读输入](../../src/client/NodeInspection.tsx)。专项使用未修改发布 SDK bundle 与真实 Store / DockKit，不操作浏览器。

| 性质 | 阈值 / 证据 | 频率与失败处理 |
| --- | --- | --- |
| 身份与安全 | 错会话 / epoch / 旧版本回执零接受，接管不排队等待呈现 | 每轮 agentPresentation / agent；失败不安装 |
| 导航与恢复 | 晚 adoption 可补偿，同 params revision 增长；浮窗尺寸 / 原标签 / 其他页保持 | 每轮 nativeCanvasNavigation / sidebarCanvas |
| 只读 | 当前三类输入可读，快照可预览；浏览不触发写入或生成 | 每轮 nodeInspection / historyInspection |
| 布局 | 真实缩放容器中心扣半尺寸；固定种子 128 节点不交叠、不移动旧节点 | 每轮 agentPresentation / canvasPresentationRender |
| 活性 | 最长 8 秒延后；关闭立即唤醒，等待不占提交队列 | 每轮 agent / agentPresentation |
| 交付 | 全量 check、双构建、编译 Host 与真实 SDK 离线、同包安装 / HTTP / 身份清单 | 每轮；成功后清过期 tgz |

人工 330–338 检查自动展开、进入正确画布、中心与卡片、跟随恢复、接管和刷新；当前待用户执行。自动化替身模型和 HTTP 核验不证明实际创作质量或视觉通过。
