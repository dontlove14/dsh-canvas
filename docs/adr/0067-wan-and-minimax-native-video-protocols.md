# ADR-0067：Wan 3.0 与 MiniMax H3 双渠道原生视频协议

状态：已采纳

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-29。
记录日期：2026-10-29。供应商文档、模型能力、鉴权或恢复边界变化时重审。

## 背景与驱动因素

1. 用户明确要求 Wan 3.0 接 Model Link、Aliyun，MiniMax H3 接 Model Link、MiniMax，并使用现有视频节点的参考 / 首尾帧交互。
2. 两协议不是 Seedance 或 Sora 接口，聚合渠道的模型目录和部分字段存在差异。已有画布、任务、模型凭据和数据库结构必须保持。

## 决策

1. 新增 `wan-video` / `minimax-video`，保留原三十个内置组合 UUID。Wan 3.0 / Prime 各两渠道；MiniMax官方H3 / Highspeed / Lite / Max四款，Model Link仅MiniMax-H3，共九个新组合，目录三十九个组合。过滤不支持项后不重新编号，保留全部仍支持的UUID。之前保存的Model Link变体记录 / 密钥 / 快照仍可读取，但不提供配置与生成候选；Host在新配置 / 生成前拒绝，不重写节点或历史任务。供应商配置按具体模型渠道独立绑定 Bearer API Key，无 EP；不接入 Aliyun 的 H3。
2. Wan 官方 base `https://maas.qianwenaiapi.com/api/v1`，Model Link base `https://api.modellink.online/wan/api/v1`。提交 `services/aigc/video-generation/video-synthesis`，查询 `tasks/{task_id}`；提交加 `X-DashScope-Async: enable`，请求使用 `input.prompt/media` 和 `parameters`，结果读取 `output.task_id/task_status/video_url`。
3. H3 官方 base `https://api.minimax.cn`，Model Link base `https://api.modellink.online/hailuo`。提交 `v2/video_generation`，查询 `v2/query/video_generation/{task_id}`；使用 `content` 多模态 role，查询读取 `task.id/status/content.url`，不调用旧版文件查询接口。官方保留 `aigc_watermark: false`，Model Link省略该字段；网关提交失败证据确认其拒绝该字段。既有失败任务保持原身份，不自动重提。
4. 公共 `shared/video.ts` 仅统一模式推断、连接与参数校验。无引用自动文生；接入图 / 视频 / 音频默认参考，首尾帧需手选，清空引用回文生。H3 文生需具体比例、首尾帧只显示自动、Lite 参考需具体比例，模式切换同步合法比例。Seedance 预审 Asset URI 仍只属于原 Seedance 官方渠道。
5. Wan 480P / 720P / 1080P、2–30秒、可开关同步音频；H3 768P / 2K，Highspeed 768P，Lite / Max 480P / 768P；前三款4–15秒，Max 5–15秒，均无音频开关。每次一个结果。各协议独立执行图片 / 视频 / 音频数量、文件大小、尺寸、同类总时长与实际编码校验，精确值见[协议参考](../providers.md)。
6. 参考准备复用任务固定的 OSS 对象版本，每次只流式暂存一份素材，核对原 hash / bytes / MIME，读取实际尺寸、时长和帧率后签名 URL。Wan 视频至少16FPS；H3 23.976–60FPS且H.264/H.265、AAC/MP3，Seedance 24–60FPS原限制保持。不得将多视频聚合为 Buffer 或 Base64。
7. 接受、固定快照 / 凭据、原任务查询、外部完成后只重试保存复用已有 Runtime；原 task_id 严格匹配，未知状态 / 错配不重提，取消 / 失败终止，Wan UNKNOWN按过期处理。查询至少3秒间隔。结果CDN不携带模型密钥。新协议值写入既有 JSON 字段，不改任何 DDL或重写旧画布。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 沿用 Seedance 请求格式 | Wan / H3 提交与查询结构不同，不能兼容 |
| 只接聚合渠道 | 不满足用户四渠道要求 |
| 新建节点与独立任务系统 | 增加交互与恢复分叉，现有视频节点足够 |
| 独立原生协议、共用交互与持久恢复 | 保留供应商差异且不改变存量结构，采用 |

## 后果

正面：新模型能力、模式比例和供应商地址可以独立更新；原模型 UUID、历史快照和预审规则保持。

负面：两套协议需分别维护；真实账户权限、额度和网关模型可用性仍需用户联调。新协议快照需要本版本读取。

## 可逆性与重审条件

若回退0.2.72，先确认没有新协议配置 / 任务 / 节点，若已有则使用支持新协议的前向修复，不通过清空数据回退。供应商文档、能力或鉴权变化时重审本决定，由开发执行者负责兼容修复与本地安装，用户负责真实账户验收。

## 验证与证据

官方来源：[Wan提交](https://platform.qianwenai.com/docs/api-reference/video-generation/wan30-video/create-task)、[Wan查询](https://platform.qianwenai.com/docs/api-reference/video-generation/wan30-video/query-result)、[H3提交](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)、[H3查询](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query)，2026-10-29读取。Model Link镜像地址和Bearer鉴权由用户提供。

0.2.75更正依据：用户明确Model Link仅支持MiniMax-H3；只读检查任务 `4393e197-8c87-4df1-b33c-bd6a0e484150`，标准H3文生请求在submit阶段返回 `unsupported field aigc_watermark`，未取得外部任务ID。专项覆盖两渠道请求字段、旧变体配置 / 凭据 / 历史保留及新请求提前拒绝，人工验收294–295。

实现：[目录](../../src/shared/modelCatalog.ts)、[公共视频行为](../../src/shared/video.ts)、[原生适配器](../../src/host/providers.ts)、[流式检查](../../src/host/media/seedanceReferences.ts)。回归：[Wan协议 / 恢复](../../tests/wanModels.test.ts)、[H3协议 / 恢复](../../tests/minimaxModels.test.ts)、[配置与编辑器](../../tests/wanModelsUi.test.tsx)、[编译Host检查](../../scripts/verify-artifact.mjs)。真实账户及用户手动验收287–291见[手动清单](../manual-tests.md)。
