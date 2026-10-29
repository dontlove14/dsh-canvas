# ADR-0053：Seedream 独立渠道、EP 路由与模型显示身份

状态：已采纳

Lite ID 与无结果状态分类由 [ADR-0054](0054-no-result-submission-failure-and-seedream-id-correction.md) 替代。

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-28。
记录日期：2026-10-28。模型目录、官方接入点、供应商协议或能力范围变化时重审。

## 背景与驱动因素

1. 用户要求接入四款 Seedream 5.0 型号的文生图与图生图；doubao 标准版支持 ByteDance / Model Link，dola 为用户指定的 NSFW 版本，仅支持 BytePlus，鉴权不能共用。
2. 用户明确要求官方请求的 model 为配置的 EP，Model Link 为 Model ID；画布节点、菜单、历史与任务中心仍显示 Model Name / Model ID，不显示 EP。
3. 官方 Pro 与 Lite 的尺寸 / 参考图上限和组图参数不同。不能套用 OpenAI multipart 或把 Pro 不支持的参数设成 disabled。
4. 现有任务身份、凭据快照、OSS结果保存、历史堆叠与拖拽性能必须保持，不重写存量图或表结构。

## 决策

增加 `seedream-image` 原生适配器和六个固定组合，保留原十二个 GPT / Banana UUID。型号与固定渠道见[协议参考](../providers.md#seedream能力与供应商)。初次接入使用用户当时指定的 `260628`；Lite 最新 ID 更正以 ADR-0054 为准，Pro 保持。

ModelRecord 的可选 `endpoint_id` 只保存官方渠道路由，必须以 ep- 开头；逻辑 name / model_id 保持。标准版 / Dola、各型号与各供应商继续使用独立 Vault binding，不复制密钥。官方保存有效 Key 前必须配置 EP；Model Link 和其他协议拒绝 EP。留空密钥保留已有版本，省略 EP 保留原值，主动清除 Key 不改历史。

新任务快照保存逻辑名称 / ID 和当前 EP，并绑定本次凭据版本。轮换配置不改变已接受任务。客户端是否可选依赖 Key + 官方 EP；半配置不展示。EP 只在设置输入框出现，不渲染到画布、参数面板、历史与任务详情。

所有渠道使用 Bearer 和 `POST /images/generations` JSON。纯文字省略 image；引用按顺序从固定 OSS 对象读取为单个 data URL / 多个 data URL 数组。官方发送 EP，Model Link 发送 Model ID。请求仅启用文生图 / 图生图和单张输出，PNG / b64_json；Lite 发送 sequential_image_generation=disabled，Pro 完全省略该参数。无 stream、组图、分层、交互或其他扩展能力。

默认 2K / 1:1 / 1张。Pro 提供 1K / 1.5K / 2K、最多10参考图；Lite 提供2K / 3K / 4K、最多14图。使用官方八种比例的明确宽高表并沿用配对排序。引用 PNG / JPEG / WebP，逐图≤30MiB、宽高>14像素、总像素≤3600万、宽高比1:16至16:1，另受宿主参考总字节限制。

响应 Base64 先验证编码长度 / 字符、实际格式与 sharp 元数据，再暂存 / 发布 OSS，保存实际 MIME / 尺寸。保留安全 HTTP(S) URL 回退，下载不转发 Key。无结果提交现在按 ADR-0054 标为 failed，不自动切渠道或重提；save_failed 重试原结果。复用历史堆叠、逐素材端点和只读查看。

SQLite DDL / user_version / 图结构不变，既有 JSON 模型配置和任务快照只增可选字段，不回填旧数据。旧版不认识新协议，产生 Seedream 任务后回退须评估快照兼容；不能通过删除新任务恢复旧版。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 用 EP 替换 model_id 并显示在节点 | 丢失可理解的型号身份，违背用户要求，不采用 |
| doubao / dola 共用鉴权或任意交叉渠道 | 可能调用错误账户和模型，不采用 |
| 沿用 OpenAI edits multipart | 与官方 image JSON 协议不符，不采用 |
| 逻辑型号保持、可选 EP 路由、独立 binding / 快照 | 满足显示、鉴权与任务固定性，采用 |

## 后果

正面：六个组合清晰隔离，画布仍可识别型号；官方接入点变化不会污染历史，图生图无需公开本地文件，旧模型与任务保持。

负面：官方账户需额外配置正确型号的 EP；插件不能从 EP 自动核实部署型号，权限和实际账户能力仍须用户联调。Base64 缓冲有内存开销，限额不等于峰值内存保证；旧版不能加载新 Seedream 快照。

## 可逆性与重审条件

可清除独立 Key 停止新提交，历史继续只读。不新增持久表字段；回退时必须保留已接受任务 / 新输出并使用能识别快照的版本。供应商变更 EP / 型号要求、请求参数、尺寸范围或用户要求其他能力时另行重审。

## 验证与证据

- [固定目录 / 尺寸表](../../src/shared/modelCatalog.ts)、[契约](../../src/shared/contracts.ts)、[配置与凭据](../../src/host/sqlite-store.ts)、[原生适配器](../../src/host/providers.ts)。
- [协议 / 隔离 / 固定快照 / OSS恢复回归](../../tests/seedreamModels.test.ts)、[设置 / 参数 / 画布和任务显示回归](../../tests/seedreamModelsUi.test.tsx)、[编译产物烟测](../../scripts/verify-artifact.mjs)。
- 2026-10-28官方文档：[ByteDance入口](https://ark.bytedance.net/docs/image-generation-api)、[BytePlus API](https://docs.byteplus.com/en/docs/ModelArk/1541523)、[Pro说明](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/ModelArk/2582774?lang=en)。Model Link路径、doubao / dola四个ID和NSFW分类以用户输入为准，不添加绕过审核参数。
- 本地交付及自动化结果见[验证记录](../verification.md)、[交付审查](../release-review.md)。真实账户、EP匹配、图生图效果与人工界面验收见[清单](../manual-tests.md)206–210；替身不证明真实服务兼容。
