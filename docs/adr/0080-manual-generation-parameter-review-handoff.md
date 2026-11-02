# ADR-0080：生成参数准备后交还画布，由用户点击提交

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-11-02。

状态：已采纳
记录日期：2026-11-02

## 背景与驱动因素

1. 用户希望图片、视频模型与参数准备完成后，Agent主动提醒前往对应节点核对或修改，由用户点击生成，避免不必要的付费提交。
2. 普通人工接管会取消主Agent，可能中断交接提醒；原10秒空闲恢复又可能在用户检查时恢复写权。

本决策补充[ADR-0079](0079-configured-generation-model-user-selection.md)的模型选择，替代[ADR-0071](0071-shared-canvas-agent-preset-and-control.md)中图片 / 视频由Agent提交的规则，并限定[ADR-0078](0078-manual-control-message-and-idle-delegation.md)的空闲恢复边界。FishTTS继续原用户授权提交。

## 决策

主Agent填写提示词、参数及真实引用后，调用`canvas_handoff_generation`，传入稳定operationId、当前revision和本轮实际nodeIds。逐项核对存在、无重复、图片 / 视频类型及有效用户模型选择；先发布对应节点的update呈现并等待回执，随后在共享提交队列再次核对revision、控制epoch与模型选择。

交接将控制切为manual并递增epoch，保存真实图的交接摘要；沿用Ledger v1的reason字段标记“参数已准备，等待用户检查并点击生成”。不写图、不创建任务、不新增数据库字段。主Agent保留只读与结束提醒的执行能力，写入和付费提交撤权，子Agent取消。提醒包含实际节点名称，并提示检查提示词、参考素材、模型和参数，允许直接修改，确认后亲自点击生成。画布同时显示适配Harness主题的提醒。窗口未可见 / 用户自主浏览时，不声称已经呈现或用户已检查。

客户端不为此manual原因安排10秒恢复；Host拒绝没有`source: "user-message"`的delegate，避免旧客户端、延迟计时器或无可见窗口绕过。原生新消息先flush，带来源与epoch恢复控制；Host pre-step仅真实新根用户消息允许该来源，交接前历史 / inbox / 工具续轮不算新消息。用户要求再次调整时按当前图工作，完成后再交接。

0.2.101按用户视觉反馈，画布顶部提醒只在可见的当前画布显示3秒，然后自动隐藏。计时绑定canvas / session / epoch，同次交接的刷新、节点编辑不会延长或复活提示；新的交接重新显示。隐藏只改变客户端提示，不解除manual原因、不恢复Agent或提交任务，聊天交接说明保持。

`canvas_generate`只接受新的FishTTS提交。新的图片 / 视频提交返回409 / `AGENT_MANUAL_GENERATION_REQUIRED`并指向交接工具，即使已选模型或用户口头说生成也不能绕过。原已接受任务仍可按原requestId / requestHash查回，结果未知不重提；canvas_task继续查询。交接工具仅重读同一manual epoch回执，不重放定位或覆盖后来人工修改，后续委托使旧回执失效。

## 正确性与验证

| 性质 | 实现与证据 |
| --- | --- |
| 不得新增Agent图片 / 视频任务 | ToolRuntime验证生成拦截，原task_catalog为空；手动生成仍使用用户修改后的最新快照 |
| 不得在检查期间恢复写权 | Host来源 / epoch guard，Client独立manual seat抑制idle；种子100的32轮回复 / 活动 / 时间交错 |
| 必须能完成提醒并让用户编辑 | 主Agent不取消、只读允许、真实pre-step继续；实际手动保存与生成快照验证 |
| 不得覆盖新图或复活旧交接 | revision / epoch二次核对，取消 / 接管 / 选择变更回执拒绝；稳定operationId重读 |
| 重启仍等待用户 | Ledger真实写入 / init后保留manual原因；原图 / 两库 / 任务身份保持 |

模型范围是主Agent、子Agent、当前画布、呈现回执、人工活动、10秒计时和新消息；不模拟模型服务计费。结果未知的历史任务只回查。自动测试覆盖ToolRuntime / Cordis与原生SessionFace，编译Host和真实SDK离线核验；执行者不调用付费模型。视觉 / 参数正确性仍由用户按手验377–381验收。

## 备选方案

| 方案 | 取舍 |
| --- | --- |
| 仅改提示词提醒 | 无法拦住付费工具，拒绝 |
| 复用普通takeover | 会取消主Agent提醒，拒绝 |
| 只在客户端暂停 | 无法约束延迟 / 旧客户端，拒绝 |
| 原reason字段、提交队列与双端idle禁止 | 采用，保持存量兼容与真实主级回复 |

## 后果

正面：生成前用户能检查和修改，最终提交权明确；存量图、两库及任务身份保持。

负面：图片 / 视频需用户逐次点击，交接后新消息可能需要重新确认失效模型选择；不可见窗口需用户自行前往节点。

## 可逆性与重审条件

没有数据库迁移；如以后恢复Agent付费提交，必须由用户明确要求，并重审授权边界、idle原因及历史回查。SDK生命周期或呈现契约变化时复核主级只读结束与来源守卫。

## 验证与证据

实现：[交接工具](../../src/host/agent/preset.ts)、[写权与新消息来源](../../src/host/agent/coordinator.ts)、[客户端idle](../../src/client/presentation.ts)、[Agent指引](../../src/host/agent/methods.ts)。

[实际工具专项](../../tests/agent.test.ts)与[32轮交错](../../tests/canvasFollow.test.ts)对应上述正确性规则。正式全量 / 双构建 / SDK / 同包安装 / HTTP证据以100manifest为准；手验377–381由用户完成。
