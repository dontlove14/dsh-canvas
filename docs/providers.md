# 模型协议与媒体参考

文档类型：参考；负责人：项目维护者；最近核对：2026-10-27。复核周期和触发条件见[文档导航](index.md)。

本页描述[已实现的适配器](../src/host/providers.ts)与[能力定义](../src/shared/contracts.ts)，不是对任何厂商当前线上 API 的兼容认证。真实账户联调仍见[验证记录](verification.md)。

当前图片 / 视频UI调用本地Mock，TTS使用下述真实FishTTS协议。Mock选项见[mockModels](../src/shared/mockModels.ts)，产物是合成样例，不按提示词执行真实推理。图片 / 视频真实协议及已接受任务保留。

0.2.17全部Mock的counts为1–10。原Mock Video保留seconds=[4,8,12]；新增Mock Video · 区间使用secondsRange={min:0,max:12,step:1}，默认1秒。区间优先于固定列表，UI不显示区间断点；0秒可保存草稿但提交拒绝。真实协议表中的数量 / 时长保持原限制，派生能力不写入模型记录，见[ADR-0029](adr/0029-generation-sliders-and-audio-wheel.md)。

## 配置与能力

API Base 是 HTTP(S) 接口前缀，例如 `https://api.openai.com/v1`；插件去掉结尾斜杠后追加路径。不得附带用户名 / 密码 / query / hash，不要填完整 generations / videos 端点。允许本地无鉴权服务；只有非空密钥才发送 `Authorization: Bearer ...`。

Model ID 可自定义；能力主要按协议固定，只有完全等于 `sora-2-pro` 时扩展视频尺寸。选项默认取各数组第一项。当前均没有音频开关。

| protocol | 类型 | 尺寸 | 数量 / 时长 | 参考输入 |
| --- | --- | --- | --- | --- |
| `openai-image` | image | 1024x1024、1536x1024、1024x1536 | 1 / 2 / 4 张 | 最多 16 图 |
| `openai-dalle-3` | image | 1024x1024、1792x1024、1024x1792 | 1 张 | 无 |
| `openai-dalle-2` | image | 256x256、512x512、1024x1024 | 1 / 2 / 4 张 | 无 |
| `openai-video` | video | 1280x720、720x1280；sora-2-pro 另有 1792x1024、1024x1792 | 1 条，4 / 8 / 12 秒 | 最多 1 图 |

以上是插件选项，供应商可能额外限制分辨率、格式、数量、权限与参考图尺寸。GPT Image / 视频引用仅 PNG、JPEG、WebP；视频 / 音频资源不作为首批协议输入。

## 图片请求与返回

无引用时 `POST images/generations`，JSON 为 `model / prompt / size / n`。DALL-E 2 / 3 另发送 `response_format: "b64_json"`；GPT Image 不发送此字段。

有引用的 GPT Image 使用 multipart `POST images/edits`，字段 `model / prompt / size / n`，每份参考图为重复 `image[]` Blob，文件名按 UUID 与 MIME 扩展名构造。当前不是单字段 image 或其他厂商编辑协议。

图片响应必须有 `data` 数组，长度与请求 n 相等。每项接受合法字符集的 `b64_json` 或无内嵌凭据的 HTTP(S) `url`；结果缺失、数量不符或解析失败视为不明确提交。每份输出先生成固定本地 UUID 并私有持久化，下载后由文件头决定实际 MIME / 扩展名。

URL 图片下载不带模型 Bearer，允许跟随重定向；若服务返回的图片链接要求额外鉴权，当前不支持。Base64 / JSON 响应需要整体缓冲与解码，不是全程零拷贝；媒体字节上限与 JSON 大小上限并不等于进程峰值内存限制。

## 视频请求与返回

`POST videos` JSON 发送 `model / prompt / size / seconds`，**seconds 为字符串**。单图引用读取文件并编码为：

```json
{
  "input_reference": {
    "image_url": "data:image/png;base64,..."
  }
}
```

这是当前实现的 wire 格式；不使用 multipart 视频创建，不支持 video / audio reference。

创建和 `GET videos/:id` 查询都要求非空字符串 `id`（最长 512）与 `status`：

| 供应商 status | 本地映射 |
| --- | --- |
| queued | queued |
| in_progress | generating |
| completed | saving，下载完才 completed |
| failed | failed；读取 `error.message` 或默认错误 |

查询返回 ID 必须与所查 ID 一致。有限 progress 截到 0–100；其他状态或无有效 ID 视为不明确响应。完成后构造 `GET videos/:id/content`，使用原配置 Bearer，同 origin 且禁止重定向。未实现 webhook、SSE、取消或获取缩略图。

## FishTTS 请求与返回

来源：[表达指南](https://apidoc.modellink.online/7812015m0)、[TTS接口](https://apidoc.modellink.online/388232172e0)，2026-10-27核对。`POST https://api.modellink.online/fish/v1/tts`，JSON为 `{"text":"(happy) 你好","reference_id":"音色ID","prosody":{"speed":1,"volume":0},"format":"mp3"}`。reference_id空时省略；speed为有限正数、volume有限且可负数，文档未给上下界。地址设置为完整端点，不追加路径；有Key时Bearer，禁止重定向。节点无模型和素材输入。

@从文档选择 `(happy)`、`(sad)`、`(soft tone)`、`(in a hurry tone)`、`(laughing)`、`(break)`、`(long-break)` 等，按文档拼写原样发送，支持叠加；不是资产引用或 `[参考图N]`。英文情绪标签须句首，语调 / 声音效果可放其他位置，界面提示位置规则。

0.2.19界面将上述已知值显示为中文文字徽章，例如 `@平静`；节点prompt、任务快照和请求text仍为 `(calm)` 等原始值，复制也是原值。普通 / 未知括号文本不转换，无新增DTO或数据库字段。

成功返回直接音频字节，按实际流与maxMediaBytes、请求超时和音频签名验证写入UUID暂存；MIME / 最终扩展名以文件头为准。失败JSON读取 `message` 或 `error.message`，最大64KiB并脱敏。401 / 402 / 422为明确失败；超时 / 5xx等不明确，沿用不自动重提规则。暂存描述持久化后保存失败可重试同次音频，不再次请求TTS；没有供应商任务ID / 查询恢复 / 即时流播放。真实账户、音色ID和情绪效果尚待人工联调。

## 超时、错误分类与结果恢复

所有协议请求使用宿主终止信号和可配置超时；提交 / 查询禁止重定向。非成功响应错误 JSON 最多读取 64 KiB；成功 JSON 上限为 `ceil(maxMediaBytes × 1.4) + 1 MiB`。

HTTP 4xx 除 408 / 409 / 429 外视为明确失败；超时、网络、5xx、上述三种 4xx，以及无法识别的成功响应，都视为不明确。首次提交明确失败会解锁节点；不明确结果进入 unknown。视频已有 ID 时临时错误继续轮询，明确查询错误暂停为 unknown，可以恢复原 ID 查询。此分类是当前保守策略，不代表供应商计费语义保证。

输出描述在下载前保存。恢复保存时优先使用同一描述 / ID；已登记且磁盘存在的文件跳过。有视频 ID 且无描述时可重新查询取得 content 路径；**已有描述时不会自动刷新过期 URL**。图片只有暂存 Base64 / 原 URL，没有通用服务任务查询或幂等协议。

## 导入与保存格式

| 识别种类 | 当前内容头识别的 MIME / 常见容器 |
| --- | --- |
| image | PNG、JPEG、GIF、RIFF WebP |
| video | ISO BMFF ftyp（常见 MP4）、qt MOV、EBML（按 WebM 标记） |
| audio | ID3 / MPEG 帧头 MP3、RIFF WAV、Ogg、FLAC、M4A ftyp |

识别器只采集文件前 512 字节做签名判断，并检查预期 image / video / audio 种类；不是完整解码器，也不能证明容器内部编码或整个文件有效。部分 ftyp / EBML 容器归类比较宽泛，浏览器仍可能无法播放；不能把表述写成支持任意 MP4 / WebM 编码。

SVG 不接受；已识别的 HEIC / AVIF 等 ftyp 品牌拒绝，其他未支持内容拒绝。PNG / GIF / VP8X WebP 可从头部取得尺寸；其他尺寸 / 时长主要来自浏览器 best effort 探测，生成视频没有服务端时长解析。

所有导入 / 生成结果通过限额流写到临时文件，签名检查后 fsync 与 rename；失败清除本次临时文件。单文件上限、参考图总上限与配置范围见[运行指南](operations.md)。

## 新增协议的改动范围

新增协议需要同时更新：shared 的枚举 / 标签 / 能力 / 默认参数 / 校验；Providers 的提交、查询、输出与错误映射；设置页的协议选择；服务恢复测试和[手动验收](manual-tests.md)；相关参考文档及必要的新 ADR。

适配器只接收提交快照，返回统一 ID / 状态 / 输出描述；不得借机修改 graph 或把密钥加入公开 DTO。相关决定见 [ADR-0002](adr/0002-node-types-and-provider-capabilities.md)。
