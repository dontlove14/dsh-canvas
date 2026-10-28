# ADR-0048：Nano Banana 原生图片协议与双供应商

状态：已采纳

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-28。
记录日期：2026-10-28。供应商接口、模型能力、返回格式或恢复语义变化时复核。

更新：用户更正Model Link契约后，原“两渠道均使用Interactions”不再有效；当前Model Link使用generateContent，Gemini保持Interactions。见[ADR-0049](0049-modellink-banana-generate-content.md)，下文原协议作为0.2.42历史决策保留。

## 背景与驱动因素

1. 用户要求将四款Nano Banana加入现有生图节点，Gemini与Model Link使用相同参数，但鉴权Header不同，不能沿用GPT的OpenAI图片请求。
2. 图片直接返回Base64，需要复用OSS发布和同次结果恢复，避免把大段图片数据写入图 / 数据库，或保存失败后再次计费。
3. 用户给定的Google图片文档在核对日使用Interactions API与正式模型ID；能力必须按模型分开，不把GPT的数量、背景和画质参数发给Banana。

## 决策

- 新增`gemini-image`协议与8个固定模型 / 供应商组合。保留原GPT四个UUID、地址和凭据；新组合独立配置Key，画布继续只显示有Key的组合，不自动切换渠道。
- 四个ID严格使用用户给定值：`gemini-3-pro-image`、`gemini-3.1-flash-image`、`gemini-3.1-flash-lite-image`、`gemini-nano-banana-2.1`；不擅自追加`-preview`。
- 两渠道均`POST /v1beta/interactions`。Gemini根地址为`https://generativelanguage.googleapis.com`，仅用`x-goog-api-key`；Model Link为`https://api.modellink.online`，仅用Bearer。Model Link协议一致性依据用户给定契约，线上兼容仍由真实账户验收。
- 文本与固定参考图按顺序编码到`input`，图片带实际`mime_type`和Base64 `data`。请求`store:false`，不使用供应商会话历史；`response_format`指定image / inline / JPEG以及比例、分辨率。0.5K在线参数为`512`。精确参数表维护于[协议参考](../providers.md)。
- 每次只请求1张，不发送GPT的`n / background / quality`，不通过多次付费调用模拟批量。Lite只开放1K和1图参考，其他型号按核对能力开放分辨率和最多14图；沿用现有十种比例顺序，不新增用户已移除比例。
- 只取`status:completed`中`steps.type:model_output`的最终image内容，忽略thought等中间内容。验证Base64长度 / 字符 / 解码字节上限、声明MIME与文件签名一致，以及sharp可读取的实际尺寸；接受PNG / JPEG / WebP，文件名、MIME和资产宽高按实际图片记录。
- 复用既有私有暂存、固定输出ID / OSS目标与结果描述。Base64只在网络 / 暂存阶段使用，图和数据库只存既有定位 / 元数据；不迁移DDL或改写存量图。
- 明确失败 / 取消映射failed；超时、网络 / 5xx、不完整状态、空输出或无效图片映射unknown，不自动重提。存在同次暂存的save_failed只重试OSS保存；未拿到可恢复描述仍保留现有RESULT_UNAVAILABLE边界，不声称exactly-once。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 将Banana伪装为OpenAI images接口 | 无法表达Google原生输入 / 返回与鉴权，不采用 |
| 继续使用旧generateContent示例 | 核对日给定文档采用Interactions和正式ID，不作为本轮契约 |
| 浏览器直接调用模型并保存Base64 | 暴露Key、绕过Host任务恢复与OSS发布，不采用 |
| Host原生适配器复用现有任务 / 存储 | 供应商差异收敛在适配器，采用 |

## 后果

正面：四款模型可在同一节点使用，渠道凭据隔离，Base64结果复用已有OSS和恢复链路，旧GPT行为保持。

负面：成功JSON和Base64仍整体缓冲，配置限额不等于峰值内存预算；请求当前固定JPEG；单次只开放1张。真实权限、尺寸、模型可用性和网关兼容尚需用户联调。

## 可逆性与重审条件

目录和协议为增量扩展，撤回时不能删除已保存的新模型或任务；旧包不认识新协议，使用Banana后需保留匹配版本读取历史。供应商更改路径、Header、返回结构、模型能力或支持明确幂等 / 查询恢复时重审，更新协议参考与测试，不通过自动改ID或重提任务兜底。

## 验证与证据

- 核对日期2026-10-28：[用户给定图片文档](https://ai.google.dev/gemini-api/docs/image-generation?authuser=4&hl=zh-cn)、[Interactions指南](https://ai.google.dev/gemini-api/docs/interactions)、[Interactions REST](https://ai.google.dev/api/interactions-api)、[Flash Lite文档](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite)。
- [目录](../../src/shared/modelCatalog.ts)、[能力 / 契约](../../src/shared/contracts.ts)、[适配器](../../src/host/providers.ts)、[Runtime](../../src/host/runtime.ts)、[设置](../../src/client/Settings.tsx)。
- [28项接入测试](../../tests/bananaModels.test.ts)、[9项UI测试](../../tests/bananaModelsUi.test.tsx)：8组合、双鉴权 / JSON / 引用、MIME / 实际尺寸、无效结果 / 失败分类、OSS重试 / Key快照与旧图DDL保持；未提交真实付费请求。
- 完整检查、双构建 / 包 / 安装身份见[验证记录](../verification.md)与0.2.42 manifest；用户手动验收[清单](../manual-tests.md)181–185。HTTP加载与协议替身不能替代真实模型 / 浏览器效果。
