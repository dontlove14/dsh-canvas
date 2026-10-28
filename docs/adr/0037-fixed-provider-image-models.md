# ADR-0037：内置供应商目录与图片比例分辨率映射

状态：已采纳

2026-10-28更新：[ADR-0044](0044-wide-image-ratios-at-one-k.md)补齐1K宽屏尺寸并将7:3统一为21:9；下文旧尺寸表和“1K宽屏不开放”是0.2.30历史决策，当前采用23个组合。目录与其他请求规则保留。

文档类型：解释；负责人：项目维护者 / 模型接入执行者；最近核对：2026-10-27。
记录日期：2026-10-27。新增模型、供应商、尺寸限制或批量协议时复核。

## 背景与驱动因素

1. 同一模型需要多个供应商，Model Link 优先且为默认；每个模型与供应商组合独立配置密钥，用户不能增加自定义渠道或 API Base。
2. 画布将比例与分辨率分为两个控件，供应商却接收 WIDTHxHEIGHT；整数对齐会改变精确比例，不能用最终宽高的最大公约数反推展示标签。
3. 所有生成任务都由后台异步执行；页面关闭不能影响已接受任务，历史输入、凭据、输出与连线身份必须保留。
4. 批量生成可能返回部分结果或部分保存失败，已经成功的图片必须保留，不能因此重复付费请求或自动切换供应商。

## 决策

画布选择器的渠道可见性已由[ADR-0040](0040-configured-provider-combinations-only.md)更新为只展示已配置组合；本节原“未配置渠道可选”规则是历史行为，不能作为当前实现依据。

首批内置 GPT Image 2.5 Sunburst / Flare，各有 Model Link 与 OpenAI 两个渠道。固定 API Base 分别为 `https://api.modellink.online/v1` 与 `https://api.openai.com/v1`；鉴权均为 Bearer Token。目录按模型分组、Model Link 在前；无密钥的渠道可选择但不能提交。切换同一模型渠道保留参数，跨模型恢复该模型默认值。不自动更换供应商。

复用模型配置的 UUID 和现有 modelId / 凭据版本引用，无新增数据库表、列或 graph 字段。新配置仅允许内置目录，Host 校验地址、模型与身份。未配置目录项使用固定 UUID；已有同一组合优先复用原 UUID。旧模型、凭据与任务快照原样保留，设置与新节点不展示自定义配置；旧内部协议任务仍可按原快照恢复。旧记录只允许保留身份的密钥更新，不能借此创建或改成新自定义渠道。TTS 保留独立凭据和节点流程，新的服务设置仅允许固定 FishTTS 端点。

图片参数增加可选 background / quality；旧节点不改写，缺省请求 auto / auto，output_format 固定 png。不传 mask、stream、user、safety_identifier、input_fidelity、moderation、response_format。无引用调用 images/generations JSON；有引用调用 images/edits multipart，重复 image[]，上限16张。n 原生1–10，一次批量请求，不拆成多次生成。

后续图片模型统一维护 `{resolution, ratio, size, width, height}` 预计算能力表，比例与分辨率来自表内标签，提交只使用 size。枚举采用英文 value / 中文 label。不得把不同模型的尺寸限制套用成通用假设。

本模型档位长边为1K=1024、2K=2048、4K=3840（UHD）；短边按比例四舍五入到16倍数。过滤宽高16倍数、单边≤3840、长短比≤3、总像素655,360–8,294,400之外的组合。尺寸高于2560×1440的实验支持由官方文档说明，用户已接受仅开放合法组合。无效比例不出现在当前档位；切换档位优先保留比例，否则选该档位首个有效比例。

| 比例 | 1K | 2K | 4K |
| --- | --- | --- | --- |
| 1:1 | 1024x1024 | 2048x2048 | 不开放 |
| 16:9 | 不开放 | 2048x1152 | 3840x2160 |
| 9:16 | 不开放 | 1152x2048 | 2160x3840 |
| 4:3 | 1024x768 | 2048x1536 | 不开放 |
| 3:4 | 768x1024 | 1536x2048 | 不开放 |
| 3:2 | 1024x688 | 2048x1360 | 不开放 |
| 2:3 | 688x1024 | 1360x2048 | 不开放 |
| 4:5 | 816x1024 | 1632x2048 | 不开放 |
| 5:4 | 1024x816 | 2048x1632 | 不开放 |
| 7:3 | 不开放 | 2048x880 | 3840x1648 |

后台接受过程沿用 requestId / 内容hash幂等回执；重复相同请求返回原任务，不重提。供应商请求仍由 Host 生命周期持有，与页面 Request.signal 无关。旧图、边、任务不重写，连线不自动执行下游。未知提交仍 unknown，无原ID时不查询或重提；4xx明确失败与5xx / 超时不明的分类保持。

收到有效部分图片后先固定输出UUID并暂存，保存完将任务标记 failed，failureCode=PARTIAL_RESULT，保留 resultIds 与说明。不增加新的状态枚举。无任何有效结果进入 unknown。某一输出保存失败继续保存其他输出，最终 save_failed；重试只保存同次输出描述，已发布文件跳过。不以保存成功掩盖原批次缺失。

本次契约演进：GET models 增加目录占位与可选 configurable / 派生能力；POST models 收紧新配置范围；GenerationParams 增加可选字段。全页、侧栏、设置与独立开发页共用同一 CanvasApi。历史读取保持，新增字段仅新版本理解；回退按完整停机备份执行，不让旧版解析新参数。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 用户自由填写渠道地址，能力只按协议推断 | 无法保证供应商身份、参数和能力一致，不采用 |
| 所有模型共享供应商密钥，失败自动切换 | 不符合独立配置和用户自行抉择要求，不采用 |
| 用实际宽高反推比例和档位 | 16对齐后产生错误比例标签，不采用 |
| 内置目录、独立凭据、按模型预计算有效尺寸 | 保留历史结构并准确约束请求，采用 |

## 后果

正面：模型和供应商明确，界面中文值与请求英文值一致；无效尺寸在前端与后台均被拒绝；离开页面、修改配置和部分结果不会重提已接受请求。

负面：1K宽屏因最低像素限制不开放，4K方形因最高像素限制不开放；未来供应商须通过代码和文档接入。大批量JSON / Base64仍受响应大小上限与内存影响，真实账户兼容性和UI必须人工验收。

## 可逆性与重审条件

新模型或供应商接入时扩展目录，不修改已有组合身份或历史任务。供应商改变限制、增加异步回执或取消原生n时重审尺寸表和批量策略。切换回旧版须使用停机备份，保留已经生成的媒体，不删除或改写任务以伪造恢复。

## 验证与证据

官方来源：[生成接口](https://developers.openai.com/api/reference/resources/images/methods/generate?site_locale=en)、[编辑接口](https://developers.openai.com/api/reference/resources/images/methods/edit?site_locale=en)、[尺寸指南](https://developers.openai.com/api/docs/guides/image-generation)，2026-10-27核对；Model Link 相同格式、固定地址与Bearer依据用户明确提供的接入契约。

实现：[目录与尺寸](../../src/shared/modelCatalog.ts)、[契约](../../src/shared/contracts.ts)、[Store](../../src/host/sqlite-store.ts)、[适配器](../../src/host/providers.ts)、[Runtime](../../src/host/runtime.ts)、[模型菜单](../../src/client/ModelPicker.tsx)。回归：[接入与恢复](../../tests/imageModels.test.ts)、[既有协议](../../tests/service.test.ts)、[TTS](../../tests/tts.test.ts)。实际账户与视觉验收见[清单](../manual-tests.md)146–150。
