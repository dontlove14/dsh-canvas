# ADR-0030：FishTTS 语音节点与限额音频流

状态：已采纳

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-27。
记录日期：2026-10-27。语音服务、输入语法、持久编码或恢复规则变化时复核。

## 背景与驱动因素

1. 用户要求独立 TTS 节点，使用提供的图标、音色 ID 和语速 / 音量计数器，以 @ 选择 FishTTS 文档的情绪表达；没有模型选择或输入端点。
2. FishTTS 返回直接音频流，需要接入既有宿主任务、音频波形和保存失败恢复，且不得修改存量数据库结构 / 内容。
3. 服务密钥不得进入节点、任务公开快照或浏览器读取响应；设置更新不能改变已接受任务的凭据。

## 决策

0.2.19显示层更新见[ADR-0031](0031-tts-emotion-badges-and-monochrome-nodes.md)：情绪改为中文文字徽章，节点空态改为单色图标；以下服务、参数和原始字符串保存决定保持。

- 新增领域节点 `tts-generation`，媒体种类为 audio；仅输出，生成成功前输出禁用。名称沿用浮动改名，结果复用 AudioNode / AudioPlayer 的手动播放、单活动身份和逐帧游标。
- `prompt` 存文字，独立 `params={type:"tts",reference_id:"",speed:1,volume:0}`；语速使用步长0.1 / 两位小数 / 最小0.1的计数器，音量步长1 / 两位小数，允许负数。服务仅验证语速有限且>0、音量有限，不假造文档未给出的上限。音色 ID 可空。
- @ 候选来自[用户指定表达指南](https://apidoc.modellink.online/7812015m0)，插入 `(happy)`、`(soft tone)` 等原始字符串；不创建资产标签 / 入边。支持中文 / 英文搜索、键盘、输入法和纯文本复制；原生编辑可用时保留浏览器撤销记录。
- 节点不选择模型；两处设置入口共用 FishTTS 全局服务设置。接口默认[文档端点](https://apidoc.modellink.online/388232172e0) `https://api.modellink.online/fish/v1/tts`。公开设置只有地址、revision、configured及密钥掩码；私有JSON存凭据版本引用，Key仅由Vault持有。
- 接受任务时在Store同一串行段固定地址 / 参数 / 文字，并在任务事务中固定credential_ref；修改设置保留旧版本供历史任务恢复。未配置时拒绝提交；不自动提交测试生成。
- 请求为JSON `text / reference_id? / prosody:{speed,volume} / format:"mp3"`，非空Key作为Bearer。音频按实际字节限额、文件头识别和请求超时写入暂存，再由原任务发布；不Base64整体缓冲。
- 未知提交不自动重提；已有暂存描述的保存失败只重试同输出，不调用TTS。流接收完成但描述未持久化的中断窗口仍可能需要人工核对，不能保证外部请求exactly-once。
- **SQLite schema.sql、21表 / 索引 / user_version不变。** 存储编码将TTS领域kind映射到已有 `audio-asset` 行；仅新TTS行的params_json含严格 `type:"tts"` 参数。加载时验证参数后还原领域kind；content_hash、增量回执和公开DTO均使用领域对象。原音频资源 / 旧节点行不改写，不覆盖图或媒体。
- 图片 / 视频继续本地Mock；TTS单独使用真实服务。旧版本不能直接读取新增TTS参数 / 快照；回退必须核对数据版本，不能假定换包即兼容新任务。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 扩大SQLite节点CHECK并迁移表 | 改动已存数据库结构，不符合用户约束 |
| 单独语音存储 / 任务执行器 | 拆散图与任务身份，重复恢复逻辑 |
| 领域节点 + 显式存储编码 + 原任务音频发布 | 保持DDL与旧数据，采用；需要明确记录旧版读取限制 |

## 后果

正面：节点参数和参考一致，表达标签可直接用于FishTTS，真实音频复用既有播放 / 缓存 / 保存恢复。

负面：TTS配置仍在JSON / Vault而非跨介质事务；请求与本地持久化有中断窗口，真实账户音色 / 情绪效果仍需人工联调。显式存储编码需要后续开发保持同一规则。

## 可逆性与重审条件

增加语音厂商、输入参考音频、模型选择、服务任务ID、流式即时播放、修改schema或需要旧包读取新TTS数据时新立决策。当前不重写旧行或旧媒体，不扩大成自动工作流。

## 验证与证据

- [契约与校验](../../src/shared/contracts.ts)、[情绪清单](../../src/shared/ttsEmotions.ts)、[存储 / 凭据](../../src/host/sqlite-store.ts)、[提交](../../src/host/service.ts)、[音频流](../../src/host/providers.ts)。
- [计数器](../../src/client/UiNumberCounter.tsx)、[情绪编辑](../../src/client/EmotionTextArea.tsx)、[TTS面板](../../src/client/TtsEditor.tsx)、[节点](../../src/client/TtsNode.tsx)、[全局设置](../../src/client/TtsSettings.tsx)。
- [服务回归](../../tests/tts.test.ts)、[控件回归](../../tests/ttsUi.test.tsx)、[画布播放](../../tests/audioCanvasPlayback.test.tsx)覆盖payload、波形、DDL不变 / hash / 重开、凭据旋转、未知不重提、同次保存和输出端点。自动化使用受控响应，不代表真实账户效果或用户视觉已验收。
