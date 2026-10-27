# ADR-0031：TTS 情绪徽章与统一单色空态

状态：已采纳

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-27。
记录日期：2026-10-27。情绪显示、编辑器交互或节点样式变化时复核。

## 背景与驱动因素

1. 用户指出TTS中的@选择应显示中文情绪文字徽章，与图片 / 视频的引用编辑一致；实际保存与回填仍应为 `(calm)` 等FishTTS值。
2. 用户要求TTS节点使用灰黑图标，去掉空态里的“文字转语音”及prompt预览，与图片 / 视频生成节点的UI一致。
3. 已保存情绪、任务和语音配置必须保持，不能为了显示徽章迁移prompt或重新提交生成。

## 决策

0.2.20图标渲染由[ADR-0032](0032-scale-aware-viewport-compositing.md)更新为静态内联SVG路径，保留同一形状和currentColor单色；不再用alpha mask。情绪徽章和空态布局保持。

- TTS复用PromptEditorController的contenteditable、选择范围、输入法、剪贴板和撤销 / 重做。增加可选codec及泛型候选；默认图片 / 视频语法与素材连线回调保持。
- 情绪codec只识别文档已知括号值，显示非编辑文字徽章，例如 `@平静`、`@自信`；data-prompt-token仍为 `(calm)`、`(confident)`。未知括号和普通文字原样显示；初始化显示已有值不触发onChange。
- 情绪徽章复用参考图徽章的边框、背景、20px高度和基线，去掉缩略图留白。选择不加额外空格，多个标签可叠加；删除 / 复制 / 剪切按完整token，提交 / 粘贴 / 撤销保留原始语法。
- 候选弹层与已有@编辑器一样使用body portal和视口限制，中文 / 英文可搜索，鼠标 / 方向键 / Enter / Tab选择，输入法确认不误选；生成前flush正在编辑的文字。
- TtsIcon保留用户提供SVG形状，用alpha mask和currentColor显示单色。空态使用dc-generation-node / dc-generation-empty，尺寸320×180，灰色caption图标44px；浮动名称保留，正文只有图标，无文案 / prompt预览，仍仅输出端点。
- 沿用[ADR-0030](0030-fish-tts-nodes-and-streamed-audio.md)的TTS服务 / 参数 / 存储编码及音频结果播放。图、任务、SQLite DDL、Key和媒体不迁移。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| textarea内继续显示英文标签 | 不能显示独立文字徽章，不符合用户反馈 |
| 把中文名称持久化到prompt再在提交时转换 | 改写已有语法，容易损失未知文本或历史兼容性 |
| 共用编辑控制器，以codec显示中文而序列化原值 | 保持数据并复用既有交互，采用 |

## 后果

正面：三类生成节点的@交互和空态保持一致，旧情绪自动显示名称，底层API参数完全保留。

负面：共用编辑器需要同时验证素材与情绪两种codec；mask显示依赖目标浏览器CSS支持，真实版式和输入法仍需用户手动验收。

## 可逆性与重审条件

显示层可回退到0.2.18，无需转换prompt；添加自定义情绪、修改FishTTS语法或改变徽章持久化方式时重审。当前不新增引用资产、输入端点或自动生成。

## 验证与证据

- [控制器](../../src/client/promptEditorController.ts)、[DOM序列化](../../src/client/promptEditorDom.ts)、[情绪codec](../../src/client/emotionEditorCodec.ts)、[文字编辑器](../../src/client/EmotionTextArea.tsx)。
- [文档情绪解析](../../src/shared/ttsEmotions.ts)、[单色图标](../../src/client/TtsIcon.tsx)、[空态节点](../../src/client/TtsNode.tsx)、[样式](../../src/client/styles.css)。
- [TTS控件回归](../../tests/ttsUi.test.tsx)验证旧文本自动徽章 / 中文名 / 原值 / 光标、原子删除 / 撤销、纯文本复制 / 剪切 / 安全粘贴、portal插入与最小空态；[原素材编辑](../../tests/promptEditor.test.ts)、[受控组件](../../tests/mentionPromptEditor.test.tsx)、[画布音频](../../tests/audioCanvasPlayback.test.tsx)保持。
