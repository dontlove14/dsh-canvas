# ADR-0090：按模型能力规划视频一致性参考并核对原始依赖

文档类型：架构决策记录；负责人：项目维护者 / 开发执行者；最近核对：2026-11-05。

状态：已采纳
记录日期：2026-11-05
实施版本：0.2.121；补充[ADR-0089](0089-agent-reference-generation-and-prompt-mentions.md)，保持[ADR-0086](0086-creative-projects-and-scoped-canvas-executor.md)的主级精确清单与单写者边界。

## 背景与驱动因素

真实会话调整提示词后，主级仍明确只连接分镜图。分镜实际生成任务使用了两份人物原图，但视频仅收到分镜，0089的标签和参数校验不能发现原始人物参考遗漏。分镜中的局部细节不等于人物、场景、道具的完整身份参考。

1. 需要逐镜规划分镜、人物、场景、道具与适用音色，独立素材直接进入模型，不能把分镜当唯一视觉依据。
2. 用户选择的模型决定支持的类型、模式与数量。用户明确要求：不支持音频参考时跳过音色一致性；各模型参考数量不同，须合理分配。不能为此自动生成TTS或强求换模型。
3. 已保存成果的真实输入与源节点当前连线、当前展示或最新任务不同，核对必须保持历史素材身份。

## 决策

主级与全部专业方法共享逐镜清单：类别、逻辑角色/场景/道具、实际source/assetId/token、用途、计数与上限、不适用/待补。分镜管构图，专门资产管完整细节；支持音频且镜头需要时将各角色音色分别绑定，并区分音色样例与实际对白。无音频输入能力则跳过，不接音频、不为此生成TTS、不阻断视觉准备或承诺音色一致性。

Agent模型目录额外返回`referenceLimits`，按模式给出image/video/audio/total，通用单图视频用default。数据来自现有协议校验使用的同一模型限额；Kling另返回referenceRoles。原模型/供应商选择、模式、尺寸、时长、音频开关及实际输入校验不变。优先必要一致性资产、按余量选辅助风格/运动；必要素材超限需主级明确协调镜头范围或用户模型选择，不能以数量不足伪造排除。

| 边界 | 契约 |
| --- | --- |
| 只读inspect | 可选nodeIds/assetIds各1–100项；空对象保留旧完整输出。主级/执行级节点范围包含自身输出、直接输入及任务摘要；无自动递归 |
| 成果来源 | referenceDependencies按asset.taskId或该结果所属任务匹配已保存snapshot.referenceIds；绝不读取当前边替代来源 |
| 专业级范围 | 所选ID须在binding内；依赖超出授权只返回outOfScopeCount，不披露外部身份或内容 |
| 参考生视频写入 | 本轮实际连接素材的已保存直接依赖，须直接连入或在精确清单中明确排除；缺失在mutateGraph前拒绝 |
| 原始依赖排除 | create/update可选referenceExclusions:[{assetId,reason}]，只允许真实当前依赖；重复、未知、已连入同时排除、空原因拒绝 |
| 生成交接 | referenceExclusions:[{nodeId,exclusions:[{assetId,reason}]}]限本轮nodeIds，重新核对；返回referenceCoverage及实际references |

referenceDependencies每项包含assetId、provenance（task-snapshot/imported/unavailable）、可用originTaskId、dependencies。依赖含assetId/available及可用source/kind/filename/token；丢失输入明确available=false，不替换为最新输出。不返回完整任务快照、供应商任务ID或凭据。原始历史无法取得时标unavailable，不能推断其曾经使用了哪些参考。

referenceCoverage含assetId、via（本镜连接的派生素材）、available、status及适用reason。status为connected/excluded/unsupported；所选模型reference模式audio上限为0时，已知音频原始依赖标unsupported并说明跳过音色，不强制排除。其他必要依赖缺少返回409 AGENT_REFERENCE_INCOMPLETE。排除原因质量由主级和人工核对，宿主不猜镜头语义。参考模式校验不要求显式首尾帧继承全部原图，也不作用于图片生成或独立改名/位置。旧分步connect可暂时准备边，但交接仍检查完整依赖。

排除不是图字段：仅绑定本轮输入与实际回执，交接再次明确提供，不修改CanvasGraph、两库DDL、历史任务、prompt格式或sidecar版本。没有自动连线、历史修补、重渲染成果或生成任务。

## 备选方案

| 方案 | 结论 |
| --- | --- |
| 仅加强提示、继续只核对已连接标签 | 不足以阻止分镜替代原图的再次遗漏 |
| 自动继承全画布或所有递归上游 | 不采用；引入无关角色、超限、循环风险和未经主级授权的意图 |
| 从源节点当前边或最新输出推断原图 | 不采用；改写历史来源，选中旧版本时结果不正确 |
| 保存新资产语义/排除字段并迁移图 | 不采用；违反存量结构约束，当前精确清单与回执足够 |
| 保存来源只读投影、主级模型规划与直接依赖核对 | 采用；可审计遗漏及明确决策，保留模型差异与单写者 |

## 后果

正面：人物原图遗漏能被拒绝，Agent能读取准确分项预算；无音频能力不再要求无效音色流程。只读小范围有助于分批处理大型画布。
负面：来源中确实无关的素材需要主级说明，排除必须在交接重新提供；未知来源和独立音色的语义需求仍需专业成果与人工核对。结构校验只能保证真实输入身份，不能保证生成模型最终一致性。

旧调用兼容；只连分镜且遗漏原始依赖的旧视频在新调整/交接时需补清单，升级本身不更改原图或提交任务。相同成功ID复用回执；失败后改变意图用新ID，修订冲突重新读取。

## 可逆性与重审条件

121安装与存量核验成功前保留120包及web profile冷备份。模型限额/模式、任务来源保存、专业范围或排除持久化需求变化时重审。

## 验证与证据

实现：[references](../../src/host/agent/references.ts)、[preset](../../src/host/agent/preset.ts)、[modelSelection](../../src/host/agent/modelSelection.ts)、[video](../../src/shared/video.ts)、[execution](../../src/shared/execution.ts)、[methods](../../src/host/agent/methods.ts)。

[真实工具回归](../../tests/agent.test.ts)覆盖分镜原始输入与当前边分离、范围与任务快照脱敏、只连分镜失败、全类参考、明确排除/交接重读、未知依赖、独立改名、首尾帧、不支持音频的Kling及无任务派发；[模型限额回归](../../tests/agentReferenceLimits.test.ts)逐模型检查每类限额与实际连接校验一致、准确任务身份及来源缺失。全量check、双构建、编译SDK、包/安装身份、HTTP和存量保留由发布清单记录；真实Agent规划与视频效果按[人工用例](../manual-tests.md)验收。
