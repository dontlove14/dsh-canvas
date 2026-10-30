# ADR-0073：画布方案使用原生临时全文预览

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-30。

状态：已采纳
记录日期：2026-10-30

补充并更正 [ADR-0071](0071-shared-canvas-agent-preset-and-control.md) 中方案审阅的调用 ID 语义，不替代控制、取消或媒体提交边界。

## 背景与驱动因素

1. 用户必须能看见完整方案，不能用摘要代替审阅正文。
2. 必须保持真实工具执行身份、原生决策动作及已存在的问题，避免错误历史查找和自动批准。

用户在 0.2.89 看见左侧方案摘要，右侧全文却显示「无法读取计划 / 未找到这份计划」。Harness 0.2.1-rc.2 的原生 `PlanReviewOpen` 将带 `review.callId` 的请求导航到 `dsh-resource://plan` 历史资源；该提供者只识别 `exit_plan_mode` 工具事件，不识别插件的 `canvas_review_plan`。将后者真实调用 ID 填进展示 intent 会错误进入历史查询。

不带展示 `callId` 的原生入口使用 `dsh-resource://plan-review`，把完整 Markdown 通过 `params.planReview.markdown` 交给原生全文组件。等待服务的 `wait.callId` 则负责实际工具执行身份，必须保留。两者用途不同。

## 决策

1. 主级 `canvas_review_plan` 保留真实 Agent、signal、`wait.callId`、完整 question.detail 和确认 / 修改选项；仅删除 `intent.callId`，选择原生临时详情路径。
2. 为当前仍由原生 UI 持有的旧待确认卡片安装可卸载适配，只装饰原生 `conversation.plan-review.actions` 中精确的 `@deepseek-ai/dsh-client-ui-plan` 组件。仅在 review.id 为 `canvas-plan`、按钮为「确认方案 / 需要修改」时移除传给原组件的展示 callId，不修改原对象、注入、样式、答案或原生 store。
3. 原生组件晚注册时同样装饰；卸载恢复组件并使已挂载包装停止适配。其他原生历史计划保持原 callId 和原导航。
4. 不修改 Harness 安装文件，不伪造 `exit_plan_mode` 日志，不代替用户回答，不提交生成。

## 备选方案

| 方案 | 未采用原因 |
| --- | --- |
| 伪造 `exit_plan_mode` 事件 | 污染原生会话历史，工具身份与业务事实不符 |
| 另建插件全文面板 | 重复原生 Markdown、主题和确认交互，扩大维护范围 |

## 后果

正面：沿用原生正文与审阅动作，修复仍存在的旧卡片，执行身份保持。

负面：依赖当前原生 slot 和临时预览契约，插件方案仍没有原生永久历史索引。

继续使用原生详情、Markdown 与决策动作，避免维护第二套方案 UI。代价是适配依赖当前 SDK 的公开 slot 记录和原生临时详情参数，升级 SDK 须重跑原生 bundle 专项。

本次修复保证活跃审阅正文的展示；未实现插件方案作为原生历史计划的永久索引，也不新增跨重启问题恢复。旧卡片仅在原生 UI 仍提供 review / detail 时可修复，不能从已丢失的会话内存重建问题。方案确认仍需用户操作，控制变化后的迟到确认继续拒绝。

## 验证与证据

[原生方案专项](../../tests/canvasPlanPreview.test.tsx) 加载未修改发布 bundle，验证新旧卡片的临时地址、完整 Markdown 传递和原生预览组件、无自动决策、原生历史 callId 保持及卸载恢复，并复现自定义工具不能进入历史提供者。Markdown primitive 使用测试壳，DOM 验证不能代表排版、主题或浏览器视觉验收。

Host 工具专项保留执行身份 / 取消 / 控制校验；真实 SDK 离线装载核对 `intent.callId` 缺失且 `wait.callId` 存在。执行者负责全量检查、双构建、同包安装、HTTP 和数据身份核验；用户按 [339–341](../manual-tests.md) 手动验收。最终结果见[验证记录](../verification.md)和版本 manifest。

## 可逆性与重审条件

移除客户端装饰即可恢复原生 slot；Host 可单独回退，持久画布、草稿、任务及数据库结构不变。回退保留会话和 sidecar，不通过重提生成来恢复预览。

SDK 提供自定义历史计划索引或审阅扩展点时重审；升级前须核对真实原生 bundle 与 slot 的 ID 和参数。
