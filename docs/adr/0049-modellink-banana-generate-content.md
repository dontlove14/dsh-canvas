# ADR-0049：Model Link Banana使用generateContent

状态：已采纳

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-28。
记录日期：2026-10-28。供应商路径、参数 / 返回结构或错误语义变化时复核。

## 背景与驱动因素

1. 本机Nano Banana 2 Lite任务在提交阶段明确失败，记录为`Invalid URL (POST /v1beta/interactions)`，未取得输出；Model Link不支持本轮此前采用的Interactions路径。
2. 用户更正Model Link契约为Google的generate-content图片文档，要求仅替换根域名，Bearer鉴权继续沿用。修复需要同时改变路径、请求和返回解析，不能只换URL。
3. 原模型ID / Key、节点参数、已失败任务和已保存媒体必须保留；不能用自动跨协议重试制造重复付费请求。

## 决策

- 本ADR部分替代[ADR-0048](0048-banana-native-image-protocol.md)中的Model Link请求 / 返回约定。Gemini继续使用Interactions与x-goog-api-key。
- Model Link使用`POST https://api.modellink.online/v1/models/{model_id}:generateContent`，严格沿用新文档REST示例的`/v1`路径；四个模型ID不追加preview，不修改目录UUID或根api_base。
- JSON使用`contents[].parts`：文本为text，固定参考图按顺序为inline_data，带实际mime_type和Base64 data。generationConfig提供responseModalities以及imageConfig.aspectRatio / imageSize；0.5K值为512。具体结构见[协议参考](../providers.md)。
- 从第一候选的content.parts读取inlineData / inline_data，兼容mimeType / mime_type；过滤thought中间图和文本，不把其他候选作为额外结果。沿用Base64限额 / MIME / sharp元数据与OSS暂存发布。
- promptFeedback明确拦截或候选明确安全 / 无图片原因映射failed；不完整结束、未知状态、无候选 / 无最终图片和无效图片映射unknown。HTTP错误分类、脱敏和不自动重提规则保持；不在失败后回落到Interactions。
- 每次仍1张，能力与UI参数保持，Base64不进入图或数据库。已有失败任务不恢复提交；用户更新后主动生成会创建新的任务，原失败记录保留。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 只换域名或路径，仍发送Interactions JSON | 与新契约字段 / 返回不符，不采用 |
| 两协议自动重试 / fallback | 无幂等保障，可能重复付费，不采用 |
| 同时改动Gemini接口和模型能力 | 用户本轮只更正Model Link，无必要扩大范围，不采用 |
| 按供应商分支，共享图片校验与保存 | 更正已证实的不兼容，保留已有数据与恢复，采用 |

## 后果

正面：Model Link调用符合用户给定REST契约，四款模型共享修复，原凭据和Base64保存保持；失败记录可追溯。

负面：两个渠道的wire协议不同，后续必须分别核对。真实Model Link账户权限与生成效果仍待用户验收；没有供应商幂等 / 查询能力，unknown不能自动重提。

## 可逆性与重审条件

适配器内部修正，无DDL / DTO / 图迁移。回退旧包会恢复已知Model Link路径故障，因此仅用于其他候选故障的本轮回退。供应商明确新增Interactions支持、修改REST版本或提供幂等查询时重审，更新独立测试和运行指南。

## 验证与证据

- 2026-10-28用户更正的[generate-content图片文档](https://ai.google.dev/gemini-api/docs/generate-content/image-generation?hl=zh-cn&authuser=4)：REST路径/v1、contents / generationConfig、inline_data参考及thought过滤。
- [适配器](../../src/host/providers.ts)、[34项Banana测试](../../tests/bananaModels.test.ts)：四型号双渠道路径 / Header、参考 / 档位、返回字段、拦截 / 不完整结果、实际格式与尺寸、OSS重试和旧失败任务重启不重提；[原GPT回归](../../tests/imageModels.test.ts)保持。
- 完整检查、双构建、编译Host、包 / 安装 / HTTP与业务保持见[验证记录](../verification.md)及0.2.43 manifest；用户[手动清单](../manual-tests.md)186–189。不调用真实付费服务，不操作浏览器。
