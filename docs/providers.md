# 模型协议与媒体参考

文档类型：参考；负责人：项目维护者；最近核对：2026-10-28。复核周期和触发条件见[文档导航](index.md)。

本页描述[已实现的适配器](../src/host/providers.ts)与[能力定义](../src/shared/contracts.ts)，不是对任何厂商当前线上 API 的兼容认证。真实账户联调仍见[验证记录](verification.md)。

图片UI已接入GPT Image 2.5 Sunburst / Flare和四款Nano Banana，TTS使用下述真实FishTTS协议，真实视频待后续接入。画布只显示有Key的具体模型与供应商组合，未配置渠道隐藏，不提供Mock候选或后备项；无配置时显示前往设置提示。配置表单保留完整目录，旧Mock节点、媒体与历史任务只读 / 恢复保留，见[ADR-0040](adr/0040-configured-provider-combinations-only.md)。

0.2.17全部Mock的counts为1–10。原Mock Video保留seconds=[4,8,12]；新增Mock Video · 区间使用secondsRange={min:0,max:12,step:1}，默认1秒。区间优先于固定列表，UI不显示区间断点；0秒可保存草稿但提交拒绝。真实协议表中的数量 / 时长保持原限制，派生能力不写入模型记录，见[ADR-0029](adr/0029-generation-sliders-and-audio-wheel.md)。

## 配置与能力

新配置仅允许[内置目录](../src/shared/modelCatalog.ts)。Sunburst=`gpt-image-2.5-sunburst`，Flare=`gpt-image-2.5-flare`；每个模型均支持Model Link（默认优先）与OpenAI。固定API Base为 `https://api.modellink.online/v1` / `https://api.openai.com/v1`；Bearer Token，每个组合独立凭据，无Key不提交。用户不能添加自定义渠道、Model ID或地址，不自动换供应商。

两款GPT图片默认1K / 1:1 / 1张 / 自动背景 / 自动画质；n1–10，最多16张PNG / JPEG / WebP参考图。背景value=auto/opaque/transparent，标签=自动/不透明/透明；画质value=auto/low/medium/high/xhigh/max，标签=自动/低/中/高/超高/最高。分辨率 / 比例来自预计算sizePresets，不用宽高反推标签；23个有效组合与排序规则见[ADR-0045](adr/0045-same-origin-waveforms-and-ratio-order.md)。4K为UHD长边3840，官方将高于2560x1440标为实验支持。

1K是小尺寸档位，16:9 / 9:16 / 21:9分别使用1280x720 / 720x1280 / 1344x576以满足最低像素限制；其余原1K尺寸保持。2K分别2048x1152 / 1152x2048 / 2048x880，4K分别3840x2160 / 2160x3840 / 3840x1648。超宽标签统一21:9，旧7:3尺寸仍可读；实际宽高以按钮title为准，2K / 4K超宽按16对齐略有取整。

所有生图模型只按参数允许项显示，比例顺序为1:1、2:3、3:2、3:4、4:3、4:5、5:4、9:16、16:9、21:9；GPT的4K仅9:16、16:9、21:9，Banana支持档位保留十种比例。不提供25:9或9:25；菜单排序不改变分辨率回退首项或历史size。

### Nano Banana能力与供应商

0.2.42新增以下四款，各有Model Link（默认优先）与Gemini两个独立渠道，使用`gemini-image`协议：

| Model ID | 显示名称 | 分辨率 | 最大参考图 |
| --- | --- | --- | --- |
| `gemini-3-pro-image` | Nano Banana Pro | 1K / 2K / 4K | 14 |
| `gemini-3.1-flash-image` | Nano Banana 2 | 0.5K / 1K / 2K / 4K | 14 |
| `gemini-3.1-flash-lite-image` | Nano Banana 2 Lite | 1K | 1 |
| `gemini-nano-banana-2.1` | Nano Banana 2.1 | 1K / 2K / 4K | 14 |

默认1K / 1:1 / 1张，无背景 / 画质选项，每次只请求1张，不发n或重复请求模拟批量；引用PNG / JPEG / WebP，仍受宿主参考总字节上限约束。Gemini根地址`https://generativelanguage.googleapis.com`，鉴权`x-goog-api-key`；Model Link根地址`https://api.modellink.online`，鉴权`Authorization: Bearer …`。0.2.43起按供应商分别使用Interactions / generateContent，配置仍存根地址、不共享两个系列的凭据。

1K名义宽高依比例顺序为1024x1024、848x1264、1264x848、896x1200、1200x896、928x1152、1152x928、768x1376、1376x768、1584x672。2K / 4K分别乘2 / 4；0.5K乘0.5，21:9为792x168。size仍存于既有节点params，请求从预设取比例与档位；返回资产按实际文件尺寸保存，不能把名义预设当作服务端尺寸保证。

以下表格为保留的旧适配器协议，不代表新配置可任意使用这些模型。旧配置与快照仍能读取和恢复，新的设置页只提供已接入目录。视频真实接入按用户后续文档进行。

| protocol | 类型 | 尺寸 | 数量 / 时长 | 参考输入 |
| --- | --- | --- | --- | --- |
| `openai-image` | image | 1024x1024、1536x1024、1024x1536 | 1 / 2 / 4 张 | 最多 16 图 |
| `openai-dalle-3` | image | 1024x1024、1792x1024、1024x1792 | 1 张 | 无 |
| `openai-dalle-2` | image | 256x256、512x512、1024x1024 | 1 / 2 / 4 张 | 无 |
| `openai-video` | video | 1280x720、720x1280；sora-2-pro 另有 1792x1024、1024x1792 | 1 条，4 / 8 / 12 秒 | 最多 1 图 |

以上是插件选项，供应商可能额外限制分辨率、格式、数量、权限与参考图尺寸。GPT Image / 视频引用仅 PNG、JPEG、WebP；视频 / 音频资源不作为首批协议输入。

## 图片请求与返回

GPT Image 2.5无引用时 `POST images/generations`，JSON 为 `model / prompt / size / n / background / quality / output_format`。output_format固定png，缺省background / quality按auto。两个供应商请求格式相同，仅API Base与独立Bearer不同；不传mask、stream、user、safety_identifier、input_fidelity、moderation或response_format。

有引用时使用multipart `POST images/edits`，同名参数转换成字符串，每份参考图为重复 `image[]` Blob，顺序与快照referenceIds一致，文件名按UUID与MIME扩展名构造。Runtime在issued前从OSS限额读取并核验固定对象；最多16图，受参考总字节数上限限制。不支持mask或其他厂商编辑协议，不擅自改成URL字段。

图片响应必须有非空data数组（最多10项）。GPT Image返回b64_json，适配器同时保留旧URL结果支持；逐项验证Base64媒体签名、单文件上限或无内嵌凭据的HTTP(S)URL。有效部分先生成固定UUID并私有暂存；成功保存后数量与n不符将任务记录为failed / PARTIAL_RESULT，保留成功resultIds和说明，不自动重提。没有任何有效输出或无法解析时unknown。某份发布失败仍保存其他份，最终save_failed，可重试同次输出描述；不会再次请求模型。

URL 图片下载不带模型 Bearer，允许跟随重定向；若服务返回的图片链接要求额外鉴权，当前不支持。Base64 / JSON 响应需要整体缓冲与解码，不是全程零拷贝；媒体字节上限与 JSON 大小上限并不等于进程峰值内存限制。

### Nano Banana原生请求与Base64返回

Gemini按2026-10-28[图片文档](https://ai.google.dev/gemini-api/docs/image-generation?authuser=4&hl=zh-cn)与[Interactions REST](https://ai.google.dev/api/interactions-api)使用`POST /v1beta/interactions`，发送`model / input / store:false / response_format`。input首项为`{type:"text",text:prompt}`，随后各参考图为`{type:"image",mime_type:实际MIME,data:Base64}`；referenceIds顺序与快照保持。

response_format为`{type:"image",delivery:"inline",mime_type:"image/jpeg",aspect_ratio:比例,image_size:档位}`，0.5K在线值是`512`。不发送GPT的prompt / size / n / background / quality顶层字段；不启用stream、会话存储或previous_interaction_id。

完成响应只提取steps中model_output的image内容，读取`data / mime_type`，不把thought图片当作最终结果。编码长度与字符、单图字节上限、MIME与文件签名一致性、sharp元数据均验证；PNG / JPEG / WebP结果使用实际扩展名、MIME、宽高。Base64先落私有恢复暂存，描述持久化后只保留固定ID / 暂存 / OSS定位，不把Base64放入图或任务表。模型可能返回多份最终图片，沿用数量不符的部分失败记录，已保存结果仍保留。

Gemini的status为failed / cancelled时明确失败；其他非completed状态、没有最终图片或无法识别图片视为unknown。无自动切渠道、重提或通用图片ID查询。save_failed有暂存时只重试同次OSS发布。原接入见[ADR-0048](adr/0048-banana-native-image-protocol.md)。

Model Link按用户更正的[generate-content图片文档](https://ai.google.dev/gemini-api/docs/generate-content/image-generation?hl=zh-cn&authuser=4)使用`POST https://api.modellink.online/v1/models/{model_id}:generateContent`，Bearer鉴权。REST示例路径是`/v1`；模型ID在路径中，不发送Interactions的model / input / store / response_format。请求如下：

```json
{
  "contents": [{"parts": [
    {"text": "提示词"},
    {"inline_data": {"mime_type": "image/png", "data": "参考图Base64"}}
  ]}],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"],
    "imageConfig": {"aspectRatio": "1:1", "imageSize": "1K"}
  }
}
```

无参考图时只有text，参考顺序按referenceIds。imageSize为512 / 1K / 2K / 4K中当前型号允许项，不指定输出MIME、工具、会话历史、candidateCount或流式。读取第一candidate的content.parts，接受inlineData / inline_data与mimeType / mime_type；过滤thought和文本，其他候选不作为额外结果。图片共用原Base64校验、实际尺寸和OSS发布。

promptFeedback明确blockReason或候选明确安全 / 无图finishReason映射failed；非STOP的其他结束原因、空候选 / 无最终图片和无效图片映射unknown。finishReason缺省时仍需有效最终图片，不用思考图凑结果；不自动回落到Interactions或重新请求。原失败任务保留，更新后用户主动生成新的任务。更正与边界见[ADR-0049](adr/0049-modellink-banana-generate-content.md)，真实账户兼容仍由用户联调。

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

0.2.35：语音节点独立读取TTS的has_api_key，未配置 / 读取中 / 读取失败均提示并禁用生成；Host新任务接纳同时要求配置记录和非空Key。空Key记录与清除后的记录不能生成，已接受任务仍用原凭据版本恢复，见[ADR-0041](adr/0041-tts-configuration-readiness.md)。

0.2.31核对：文档的model是**Header参数**，请求固定 `model: s1`，与Content-Type和Authorization并列；Body不增加model。原实现漏传该Header会默认speech-1.5，而文档注明只有s1支持情绪处理。text / reference_id / prosody.speed / prosody.volume / format=mp3与文档一致，其他可选项使用供应商默认值。内部任务model_id仍fish-tts，无历史快照迁移；见[ADR-0038](adr/0038-model-configuration-summary-and-tts-header.md)。

来源：[表达指南](https://apidoc.modellink.online/7812015m0)、[TTS接口](https://apidoc.modellink.online/388232172e0)，2026-10-27核对。`POST https://api.modellink.online/fish/v1/tts`，JSON为 `{"text":"(happy) 你好","reference_id":"音色ID","prosody":{"speed":1,"volume":0},"format":"mp3"}`。reference_id空时省略；speed为有限正数、volume有限且可负数，文档未给上下界。新设置仅使用固定完整端点、不追加路径，独立Model Link凭据；旧任务仍使用原快照地址 / 密钥。有Key时Bearer，禁止重定向。节点无模型和素材输入。

@从文档选择 `(happy)`、`(sad)`、`(soft tone)`、`(in a hurry tone)`、`(laughing)`、`(break)`、`(long-break)` 等，按文档拼写原样发送，支持叠加；不是资产引用或 `[参考图N]`。英文情绪标签须句首，语调 / 声音效果可放其他位置，界面提示位置规则。

0.2.19界面将上述已知值显示为中文文字徽章，例如 `@平静`；节点prompt、任务快照和请求text仍为 `(calm)` 等原始值，复制也是原值。普通 / 未知括号文本不转换，无新增DTO或数据库字段。

成功返回直接音频字节，按实际流与maxMediaBytes、请求超时和音频签名验证写入UUID暂存；MIME / 最终扩展名以文件头为准。失败JSON读取 `message` 或 `error.message`，最大64KiB并脱敏。401 / 402 / 422为明确失败；超时 / 5xx等不明确，沿用不自动重提规则。暂存描述持久化后保存失败可重试同次音频，不再次请求TTS；没有供应商任务ID / 查询恢复 / 即时流播放。真实账户、音色ID和情绪效果尚待人工联调。

## 超时、错误分类与结果恢复

0.2.44允许同节点再次提交图片 / 视频 / TTS，每次仍为独立请求 / 固定快照，适配器不合并批次、不改n或供应商并发配置。历史卡片由任务结果派生，不新增真实视频渠道。未知响应仍不自动重提，已有暂存只恢复同任务保存；见[ADR-0050](adr/0050-submission-history-and-expanded-result-ports.md)。

所有协议请求使用宿主终止信号和可配置超时；提交 / 查询禁止重定向。非成功响应错误 JSON 最多读取 64 KiB；成功 JSON 上限为 `ceil(maxMediaBytes × 1.4) + 1 MiB`。

HTTP 4xx 除 408 / 409 / 429 外视为明确失败；超时、网络、5xx、上述三种 4xx，以及无法识别的成功响应，都视为不明确。首次提交明确失败会解锁节点；不明确结果进入 unknown。视频已有 ID 时临时错误继续轮询，明确查询错误暂停为 unknown，可以恢复原 ID 查询。此分类是当前保守策略，不代表供应商计费语义保证。

输出描述在下载前保存。恢复保存使用同一描述 / ID / objectKey；已发布对象核验后跳过，存在暂存时只重试OSS发布，不重新下载过期输出。尚未得到暂存时仍依赖原供应商链接；已有视频ID且无描述可重新查询content路径，已有描述不自动刷新供应商URL。图片无通用服务任务查询或幂等协议。

0.2.37新增统一modelReferenceUrl：真正提交URL协议前核验固定对象，生成24小时新签名，不用页面1小时缓存，不持久写入快照。当前图片multipart和视频data URL仍使用字节准备，无参考的FishTTS保持原格式；尚未接入的URL渠道不能声称已实测外部抓取。参考准备失败不置issued或发送付费请求。见[ADR-0043](adr/0043-object-storage-and-expiring-media-access.md)。

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
