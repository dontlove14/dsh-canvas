# ADR-0060：画布文字默认禁止选中，输入与复制区域显式开放

状态：已采纳

文档类型：解释；负责人：项目维护者 / Client开发执行者；最近核对：2026-10-29。
记录日期：2026-10-29。新增画布组件、编辑器或portal弹层时复核；宿主控件或文字选择策略变化时更新。

## 背景与驱动因素

1. 点击节点后，下方卡片的上传文字、模型摘要等有时出现浏览器文字选中高亮，干扰画布操作。
2. 用户要求将策略改为画布全局默认禁止文字选中，再开放提示词、节点重命名及其他输入框。新增普通组件应自动受保护，开发者仅为确有选择 / 复制需求的区域开放。
3. 提示词包含原子引用与情绪标签，支持光标、输入法、选择、剪贴板及撤销；节点名称进入编辑时自动全选。不能为修正普通文字高亮而破坏这些行为。
4. 模型、参数和候选菜单使用body portal，单纯依赖画布DOM父级继承会漏掉这些弹层；同时不能扩大到Harness其他页面、项目列表或设置 / 任务弹窗。

## 决策

### 默认策略与边界

画布工作区 `.dc-canvas-area` 及其全部后代默认设置 `user-select: none` 和 `-webkit-user-select: none`。这是浏览器文字选择规则，不关闭React Flow节点框选、多选、拖动、平移、连线或现有键盘行为。

明确重置后代而非只写父级继承，避免浏览器实现差异以及控件自带样式重新开放普通标签。公共默认规则与开放规则使用 scoped `!important`，开放规则以更高选择器优先级覆盖；组件不再自行维护普通文字的禁选清单。

范围仅限画布区域及属于它的菜单弹层。页头、项目列表、设置 / 预审 / 任务 / 媒体预览弹窗和Harness其他功能保持原选择策略；不在body、document或整个插件根上禁选。

### 输入与复制开放规则

- `input`、`textarea` 自动允许文字选中，包含宿主Input内部的实际输入元素，以及名称、音色ID等输入框。
- 显式可编辑容器 `contenteditable=""`、`"true"` 或 `"plaintext-only"` 及其后代允许选中。
- 普通只读展示若需要复制，在最小内容容器设置 `data-dc-text-selectable="true"`；该容器及其后代允许选中。不要为方便给整张卡片、整组菜单或画布标记开放。
- 提示词和TTS文字编辑器明确带此标记，因此任务提交期间变为不可编辑时仍可选择 / 复制。引用和情绪标签保留原子 `user-select: all` 语义。
- 历史生成记录的只读提示词和参数值采用同一开放标记，继续可复制；模型摘要、参数标题和普通说明默认禁止选中。

不增加全局pointer / mousedown / selectstart拦截，不清空Selection，不接管剪贴板，不修改输入控制器、持久化字段或任务身份。自动全选、输入法、复制粘贴和撤销由既有控件 / 控制器处理。

### portal与后续组件接入

`CanvasTextSelectionProvider` 只包裹画布工作区，React context随portal传播。画布拥有的portal根元素通过 `useCanvasTextSelectionScope()` 添加 `.dc-canvas-text-scope`，使用同一套CSS规则；普通页面调用时hook返回空字符串。

公共 `UiSelect`、`UiActionMenu` 自动将该class传给宿主公开Menu的 `listClassName`。模型 / 参数及两种 @ 候选弹层也在各自portal根使用此hook；嵌套公共菜单继续继承React context，无需扫描或修改body节点。

后续普通画布组件无需单独添加禁选样式；原生输入框无需额外标记。新增自定义可复制内容使用统一开放标记，新增画布portal必须接入作用域hook并验证实际弹层DOM。若宿主组件没有公开的弹层class入口，先评估公开接口或适配方案，不依赖内部CSS类名或全局DOM监听。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 每个标签、按钮分别设置禁止选中 | 新组件容易遗漏，违背用户要求，不采用 |
| 只在画布父元素设置none | 浏览器继承、原生组件样式及body portal存在遗漏，不采用 |
| document级拦截所有选择事件，再判断输入目标 | 会影响光标、输入法及宿主其他页面，增加事件耦合，不采用 |
| 画布统一默认禁止，输入与复制区域显式开放，portal传递作用域 | 范围明确、新增组件默认覆盖，采用 |

## 后果

正面：画布普通展示不再因点击 / 拖动产生文字高亮；输入和历史复制保留；后续开发只需维护开放区域，公共菜单自动覆盖。

负面：普通名称、摘要等默认不能通过拖选复制。新增复制区域或自定义portal需要按统一入口接入；CSS作用域的优先级需要维护。DOM测试只能证明规则匹配和组件行为，不能证明真实鼠标拖选效果。

## 可逆性与重审条件

这是Client交互策略，没有数据迁移或接口变化。可通过移除作用域provider / CSS恢复原规则；开发者不得以单个组件临时禁选代替策略重审。用户扩大复制范围、引入Shadow DOM、宿主弹层接口改变或新编辑器存在选择兼容性问题时重审。

## 验证与证据

- [公共作用域](../../src/client/canvasTextSelection.tsx)、[画布接入](../../src/client/Canvas.tsx)、[CSS规则](../../src/client/styles.css)、[宿主菜单适配](../../src/client/ui.tsx)。
- [提示词](../../src/client/MentionPromptEditor.tsx)、[TTS文字](../../src/client/EmotionTextArea.tsx)、[名称输入](../../src/client/NodeTitle.tsx)、[只读快照](../../src/client/GenerationSnapshotEditor.tsx)。
- [专项回归](../../tests/canvasTextSelection.test.tsx)覆盖真实CSS与DOM匹配、新增普通后代、输入 / 复制开放、名称自动全选 / Enter / Escape、画布内外portal、忙碌编辑器和原子标签。
- 既有[提示词控制器回归](../../tests/promptEditor.test.ts)、[候选插入 / 撤销](../../tests/mentionPromptEditor.test.tsx)、[框选回归](../../tests/marqueeSelection.test.tsx)及[音频拖动回归](../../tests/audioDrag.test.tsx)与全量检查继续执行。具体自动结果以本轮[验证记录](../verification.md)及版本manifest为准。
- [手动清单](../manual-tests.md)247–250由用户检查真实文字拖选、复制粘贴 / 输入法 / 撤销、节点框选 / 拖动 / 连线及画布外选择边界。未将自动DOM或HTTP检查视作浏览器验收通过。
