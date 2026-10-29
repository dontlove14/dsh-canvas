# ADR-0062：节点删除使用 Harness 确认弹窗

状态：已采纳

文档类型：解释；负责人：项目维护者；最近核对：2026-10-29。
记录日期：2026-10-29。删除入口、Harness Modal契约或任务保护变化时重审。

## 背景与驱动因素

1. 用户指出选中节点后按Delete仍显示浏览器确认框，明确要求使用DeepSeek Harness的弹窗确认组件。
2. 旧实现直接在React Flow的`onBeforeDelete`中调用`window.confirm`，与已接入Harness的设置、命名弹窗不一致；异步确认还需避免任务状态变化造成误删。

## 决策

- 复用公共`UiModal`及`UiButton`，Harness运行时直接使用宿主提供的Modal / Button。标题为“删除节点”，显示节点数量、解除连线及保留媒体 / 下游结果的原说明，只有“取消 / 删除”两个按钮。440px紧凑布局，颜色 / 字体 / 焦点管理由Harness负责，初始焦点在取消按钮。
- 保留React Flow原生Delete / Backspace、`deleteElements`、删除候选及连线联动；只删除连线仍无需确认。输入框和提示词中的删除键继续由编辑器处理。
- 以Promise连接异步弹窗与`onBeforeDelete`。取消、Escape、关闭、隐藏标签 / 页面、切换画布或卸载均返回false；重复请求不覆盖原弹窗或原候选。
- 弹窗打开前和确认后均检查最新可见性 / 画布身份、节点是否仍存在、提交中及未结束任务。不能以弹窗打开时的任务快照执行迟到删除，也不能要求确认时焦点仍位于画布，因为焦点此时属于弹窗。
- 沿用原图修改 / 保存与Host约束，保留媒体、下游结果和任务历史；不改变两库DDL、持久化画布结构、供应商提交或生成任务身份。

## 备选方案

| 方案 | 评价 |
| --- | --- |
| 继续浏览器confirm | 不满足用户明确要求，无法融入宿主主题 |
| Harness RiskConfirmation | 额外要求勾选确认，增加用户未要求的步骤 |
| Harness Modal / Button与异步删除保护 | 与现有弹窗一致，保留原按钮和业务，采用 |

## 后果

正面：弹窗遵循宿主黑白主题和键盘交互，保持原删除范围和媒体保留规则。

负面：异步等待需要生命周期及实时任务保护，由独立hook维护，避免在画布主组件中重复处理。

## 可逆性与重审条件

独立开发页继续使用原语义dialog适配；可替换适配器而不改删除或存储契约。删除入口、Harness Modal契约或任务保护变化时重审。

## 验证与证据

[删除确认实现](../../src/client/useNodeDeleteConfirmation.tsx)、[画布集成](../../src/client/Canvas.tsx)、[公共UI](../../src/client/ui.tsx)和[回归](../../tests/nodeDeleteConfirmation.test.tsx)。真实CanvasWorkspace / ReactFlowProvider / 键盘和deleteElements验证确认、取消、关联连线、保存、媒体保留、输入隔离、任务更新、重复请求和可见性 / 卸载边界。Harness loader使用公开组件契约替身，不声称宿主视觉或真实浏览器焦点已验收。

完整交付见[验证记录](../verification.md)和[审查](../release-review.md)，用户按[手动清单](../manual-tests.md)258–260验收；本轮同时交付此前的视频拖拽与双指手势修复，255–257继续适用。
