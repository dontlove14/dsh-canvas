# ADR-0085：按节点组织的节点与精确素材 # 引用

文档类型：架构决策记录；负责人：项目维护者 / 开发执行者；最近核对：2026-11-03。

状态：已采纳
记录日期：2026-11-03
实施版本：0.2.112；扩展[ADR-0083](0083-visible-canvas-reference-catalog.md)与[ADR-0084](0084-canvas-only-hash-references.md)。经用户批准的产品方案见[设计提案](../proposals/canvas-node-and-media-references-v0.1.md)。

0.2.113补充输入框提示：通过原生conversation.composer.bar插槽装饰消息提示，按本会话agentPreset投影仅在无限画布追加「# 画布资源引用」。沿原生默认 / 首页 / 计划提示，不覆盖不可用、工作区选择、阻断或排队状态提示；切预设与插件卸载恢复原文，不改编辑器或输入内容。

## 背景与驱动因素

1. 用户需要引用手动创建的空节点，明确本轮解释、改名、参数、提示词或生成准备的对象。按素材罗列无法表达尚无结果的节点，也不能依靠同名节点定位。
2. 节点的当前输出可能与直接上游连线使用的历史素材不同。需要同时保留节点的实时配置身份和素材的固定结果身份。
3. 当前 / 堆叠 / 历史结果需统一组织，200条上限必须提供后续浏览；原生工作区@与旧消息保持兼容。

## 决策

1. 显式 `view=node-media` 启用新目录；当前 / 最近分类画布排序不变。画布内按graph.nodes顺序显示六类节点，空节点可选。点击 / Enter插入节点，原生箭头 / Tab钻入素材，节点下方直接提供当前展示结果。
2. 新节点标记为 `version:2,kind:node,sessionId,canvasId,nodeId,label`，聊天仅显示#节点名称。旧version1 media/file继续解析，不迁移图、边、任务或历史。素材保持原assetId，不转换成操作目标。
3. 资源节点使用绑定assetId；生成节点复用nodeResults的最近有结果任务及selectedResultId / 第一份规则。该批按resultIds展开，历史按createdAt及原接受顺序组织为折叠目录；同节点去重。搜索命中历史时直接提供准确素材行。
4. 每次读取一份保存快照，以节点 / 任务 / 素材 / 直接邻接索引组装目录和详情。200行分页绑定根会话、查询、完整browse、画布、graphRevision及返回身份；Host签名校验，重启或修订失效返回409 REFERENCE_STALE，客户端保留关键词重新查询。分页边界保留节点及其当前素材，分类元数据完整。
5. canvas_read_reference仅主Agent可用，仅读取本根用户实际提交引用。节点默认返回当前配置、公开模型、修订、输出 / 任务摘要和直接上下游；上游以edge.assetId为准。可选assetId只允许自身实际输出 / 绑定或当前直接上游，图片在读取前后及保存附件后复核关系 / 修订 / 身份 / 控制权；视频音频仅元数据。读取不导航或委托。
6. 菜单查询及节点codec等待已挂载对应画布的原保存流程，包括隐藏画布与全局画布。冲突或失败阻止读取旧稿 / 发送并保留草稿；不新增保存协议。原prepareMessage继续处理用户新消息控制恢复。
7. 节点引用明确对象，自然语言明确动作。主Agent默认只修改明确目标，邻接不授予批量写权限。现有操作增加可选canvasId/referenceId，校验受控画布与已提交节点匹配；同UUID跨画布也不能误写。仍以revision、operationId、owner/epoch和原控制权规则提交。

## 契约、兼容与错误

| 表面 | 变化与演进 |
| --- | --- |
| choices GET / browse | 加法items / graphRevision / nextCursor / truncated；view、nodeId、taskId、cursor可选且strict；旧请求保留media投影 |
| resolve POST / codec / 历史 | 节点新version2；旧media/file不重定义，未知kind/version失败而保留草稿；新客户端与Host同包升级 |
| read_reference | 加法可选assetId；普通media/file不得借此切换资产；GET / resolve / read无图写入，可重试 |
| update / connect / generate / handoff等 | 加法canvasId/referenceId校验；既有幂等ID及revision不变；控制权不通过引用获得 |
| 错误 | 400 INVALID_REQUEST修正输入；403 REFERENCE_SESSION/FORBIDDEN无权限或对象错误；409 REFERENCE_STALE重查；GRAPH_CONFLICT重新读取；原AGENT_SESSION_BUSY/CANVAS_BUSY/CONTROL_REVOKED保持 |
| 回退 | 保留旧包直至本机新包核验成功；旧包不支持node2，不能改写新历史为素材或猜名称；无数据库回滚 |

调用方为同包菜单 / API / codec、历史显示与主Agent工具；HTTP保持原owner认证、取消信号及同源凭据。只展开一个画布 / 节点，不因目录访问批量下载媒体。

## 备选方案

| 方案 | 结果与取舍 |
| --- | --- |
| 独立节点与素材两大列表 | 重复列出生成节点，堆叠 / 历史归属不直观，不采用 |
| 只列节点、所有素材必须钻入 | 常用当前素材引用增加步骤，不采用 |
| 节点与当前素材相邻、原生双动作、历史目录 | 采用，统一身份归属并保留常用一步选择 |

## 后果

正面：空节点和一般操作有稳定目标；上下游与历史素材准确；保存、权限及输入框由既有流程维护。

负面：新增node2协议需要同包升级；读取期间修订改变会要求重新读取，分页不能跨查询或重启复用；程序核验不能证明Agent所有自然语言意图都已正确理解。

## 可逆性与重审条件

Harness原生支持画布节点引用或图上下文扩展时重审适配；更多依赖层级、跨owner访问、真实视频理解或新节点编辑能力须另立方案，不能顺势扩大本次范围。

## 验证与证据

实现：[共享索引](../../src/shared/referenceCatalog.ts)、[Host目录](../../src/host/agent/chatReferences.ts)、[读取与写入](../../src/host/agent/preset.ts)、[原生菜单](../../src/client/chatReferenceTrigger.ts)、[保存屏障](../../src/client/presentation.ts)。

专项：[节点 / 历史 / 旧输入](../../tests/nodeReferences.test.ts)、[真实读取 / 分页 / 误写拒绝](../../tests/agent.test.ts)、[原生指针 / Enter / Tab / codec](../../tests/chatReferenceTrigger.test.tsx)、[隐藏草稿保存](../../tests/canvasPresentation.test.ts)。全量检查、双构建、原生SDK和本机包 / 加载 / 数据身份以112manifest为最终记录；用户手验401–407。
