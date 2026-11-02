# ADR-0075：Agent 当前节点高亮与画布视角居中

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-11-02。

状态：已采纳
记录日期：2026-11-02

## 背景与驱动因素

用户要求操作中的节点实时使用推荐的 Border beam 高亮，节点保持在画布视图正中间，通过移动画布实现。补充 [ADR-0072](0072-agent-presentation-navigation-and-readonly-inspection.md)；仅替代其靠上放置节点以完整容纳输入卡片的视角策略，原窗口导航、控制和布局保持。

1. 当前选中节点不等于 Agent 当前操作节点；用户自主浏览后仍需识别 Agent 实际目标，运行结束不能继续显示“正在操作”。
2. 节点视角中心必须来自真实容器和实际节点尺寸；提示词卡片应自行滚动，不推动节点偏离中心，也不能持久修改节点位置。
3. 已有 `border-beam@1.4.1` 可复用；直接使用依赖的边框几何和动画，保持 Harness 主题、媒体可见与输入交互。

## 决策

Host 使用原生 `Agent.status` 的 running / idle，主级 `agent/status` 唤醒既有呈现事件通道。`PresentationState.running?` 是即时字段，仅存在有效意图时返回；不写入 sidecar、台账或两库。旧客户端可忽略新增字段，新客户端缺少字段时兼容既有意图；无有效意图仍返回 `{intent:null}`。接管 / 会话关闭继续同步使旧 epoch 失效。

修改、连接和生成工具在已核验的真实目标上、业务调用前发布 `operationId:working` 意图，完成后发布原操作意图；新节点完成创建后才展示。附件占位创建后立即发布其真实 nodeId，再接收原媒体；读取图片与查询任务定位实际归属节点。重试先查原业务回执，不重放工作中意图或重复生成。UI 等待仍在提交队列外，未增加模型调用。

Client 原订阅独立追踪 running 变化，处理同一意图的 idle 转换，不接受旧时间事件。共享 MediaNode 只给匹配 session / canvas / epoch、已载入图版本的当前目标投影 `agentFocused`。Beam 是绝对定位、无指针事件、透明内部的边框，位于所有节点类型的公共壳中；不覆盖内容、不替换任务 Loading、不加入节点或图字段。只重绘原目标与新目标，原媒体组件和 DOM 保留。

用户暂停跟随时保留高亮；运行结束、隐藏、切会话、版本未就绪或接管时移除。Beam 使用 md 彩色旋转边框，传入原共享 Harness theme，减少动态效果时保留静态边框并暂停依赖动画。离屏节点由原 React Flow 可见渲染卸载，不增加每节点轮询。

跟随只通过 `setViewport` 平移，主目标中心 = 节点 position + 实际 measured / width / height 的一半。保持当前倍率，节点与最小可滚动输入卡片无法容纳时才降低到原 minZoom 内。输入卡片宽度与水平位置限制在容器内，高度按节点下方剩余空间滚动；不再按节点与卡片合并边界偏移视角。容器 / 节点 / 卡片尺寸变化由受控 ResizeObserver 重新测量。DOM 回执要求主节点中心误差不超过 1px、节点与卡片均可见；极窄窗口仍返回延后，不伪报。

| 上下文 / 责任 | 数据与邻接边界 | 故障与检查路径 |
| --- | --- | --- |
| Coordinator / 执行者 | 原生 Agent 状态上游 → 呈现投影下游；不修改权限契约 | agent / agentPresentation；接管拒绝旧 epoch |
| AgentPresentation / 执行者 | 原工具归属 → 原 SSE / 最新状态；新增 running 即时字段 | 旧意图和非主级状态不复活，不扩大持久格式 |
| useCanvasPresentation / 执行者 | 呈现身份 → 主节点中心 / 只读卡片；遵从 React Flow 视角 | 暂停不平移，超窄延后，observer 随作用域卸载 |
| MediaNode / 执行者 | 临时目标 → 真实依赖边框；沿用主题上游 | agentHighlight / canvasPerformance；不重挂媒体 |

## 备选方案

| 方案 | 取舍 |
| --- | --- |
| 用 selected 作为高亮、继续靠上定位 | 人工浏览会指向错误目标，节点不在中心；不采用 |
| 移动节点到视图中央 | 改变布局与持久图，无法满足用户要求；不采用 |
| 临时运行投影、依赖边框与独立视角居中 | 已采用，复用通道和依赖，增加少量生命周期与尺寸核验 |

## 后果

正面：真实操作目标明确，节点居中，原布局、媒体和生成身份保持；提示词与历史仍可阅读和复制。

负面：窄窗口下倍率可能降低、卡片需要内部滚动。DOM 测量与依赖边框仍需人工视觉验收；增加低频 observer 和同意图状态订阅，不提供高频每帧 React 重绘。

## 可逆性与重审条件

回退91包保留所有原文件、任务与呈现 sidecar；新增 running 不持久化，工作中意图仅用旧版已支持的 action，没有数据库迁移。视角与高亮可各自移除。若原生状态语义或 Beam API 改变、原生提供高亮能力、真实面板测量不满足中心误差，应重审对应适配；先用接管 / 暂停退出当前呈现，不删除任务或重新生成。

## 验证与证据

入口：[运行状态](../../src/host/agent/coordinator.ts)、[工具目标](../../src/host/agent/preset.ts)、[视角与回执](../../src/client/useCanvasPresentation.ts)、[依赖边框](../../src/client/AgentNodeHighlight.tsx)。使用真实发布依赖与 SDK 离线工具；不操作浏览器。

| 性质 | 阈值 / 度量来源 | 频率 / 失败处理 |
| --- | --- | --- |
| 图与任务隔离 | 节点 position、媒体组件、原生成回执保持，业务重试零重复生成 | 每轮 agent / agentHighlight / canvasPerformance；失败不安装 |
| 状态与身份 | 同意图 idle 清除；错误会话 / epoch / 图版本零高亮 | 每轮 canvasPresentation / agentHighlight |
| 中心与只读 | 实际 DOM 主节点中心误差 ≤1px，卡片可见才回执，输入仍只读 | 每轮 canvasPresentationRender / nodeInspection |
| 兼容与活性 | 两库 DDL、sidecar版本1保持；8秒延后且接管不等待 | 每轮 agentPresentation、真实 SDK 与安装数据核验 |
| 依赖与主题 | 使用真实 Beam；无内容遮罩 / Orb，减少动态效果暂停 | 每轮 agentHighlight / nodeLoading；视觉按350–355 |

全量、双清理构建、编译 Host、真实 SDK、同包安装与数据身份最终结果见92manifest。用户手动350–355尚待执行；程序回执不等于视觉通过。
