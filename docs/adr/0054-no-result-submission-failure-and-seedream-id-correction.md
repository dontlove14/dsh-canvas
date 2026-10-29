# ADR-0054：无结果提交标记失败、红色感叹号与 Seedream ID 更正

状态：已采纳

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-28。
记录日期：2026-10-28。任务恢复、供应商查询能力或型号标识变化时重审。

## 背景与驱动因素

1. 用户反馈渠道不可用及提交超时的任务被标记为“提交结果待确认”，画布暂停的 Orb 容易误解为仍在生成；明确要求此类任务显示失败和红色感叹号。
2. 用户更正 Seedream / Dola Lite 的 Model ID，需保留独立凭据、EP和历史任务。

本记录替代 [ADR-0046](0046-dependency-backed-whole-node-loading.md) 的失败静态依赖效果和 [ADR-0053](0053-seedream-endpoint-routing-and-model-identity.md) 的 Lite ID / 无结果 unknown 分类条款，其余决策保持。

## 决策

首次提交没有可用结果或可查询外部 ID，遇到拒绝、网络错误、超时、空图、无效返回或宿主中断，结束为本地 `failed`，解除节点 / 模型的任务锁。不得再自动提交同一任务。

“本地失败”表示插件未完成生成，不证明供应商没有接收请求或没有扣费。保留 issued 标记、原始错误、尝试记录、任务 UUID、request ID、模型 / EP / Key 快照；用户主动点击生成建立新任务。

有外部 ID 的视频查询保持原恢复机制：临时错误按间隔查询，明确查询错误暂停为 `unknown`，可恢复原 ID。已收到输出但下载 / OSS保存失败继续 `save_failed`，重试只处理原输出。

启动时仅修正历史 `unknown` 中已提交、无外部 ID、无私有输出、无已发布结果、无外部完成时间的任务为 `failed`。不新增尝试、不调用供应商、不改快照或任务关联；其他历史状态保持。

画布 `failed` / `unknown` / `save_failed` 显示静态 SVG 红色感叹号，颜色跟随 Harness `--dc-danger`，可读状态保留在屏幕阅读器文本中。此分支优先于媒体加载，不挂载 Beam / Orb，不产生动画循环；原有效媒体、堆叠、端点、尺寸和播放器身份保持。活动任务和普通媒体加载继续沿用原依赖。

## Model ID 更正与配置保留

| 型号 | 当前 ID |
| --- | --- |
| Seedream 5.0 Lite | `doubao-seedream-5-0-260128` |
| Dola Seedream 5.0 Lite | `dola-seedream-5-0-260128` |
| Seedream 5.0 Pro | `doubao-seedream-5-0-pro-260628` |
| Dola Seedream 5.0 Pro | `dola-seedream-5-0-pro-260628` |

仅更正 Lite 的已发布固定 UUID、名称、协议、供应商地址和旧 ID 全部匹配的配置，原子写回 models.json；UUID、Key / Vault binding 和 EP 保持，自定义模型不改。历史任务的旧 model_id 保留用于审计，旧快照仍可识别能力。ByteDance / BytePlus 请求继续传 EP，Model Link 新任务传更正 ID；画布 / 任务中心显示型号名称 / ID。

SQLite schema、DDL、图和媒体存储格式不变；不清理历史、不重提失败任务。

## 必须保持的性质

安全：同一已 issued 任务不得因超时、更正配置或重启再次提交；原输出保存重试不得创建新输出身份；更正配置不得轮换凭据或覆盖已接受快照。

终止：没有结果且无可查询 ID 的失败提交必须退出活动态；失败显示不得因旧媒体加载再次变为 Loading。

反例：旧实现将不明确提交转 unknown 并挂载暂停 Orb；新状态分类和优先显示失败分支消除该误导，保留远端副作用的不确定性。恢复仍使用原 Worker lease，重启先清理租约，已 issued 分支阻止重复提交。

## 验证与证据

- [运行时状态转换](../../src/host/runtime.ts)、[原子配置更正](../../src/host/sqlite-store.ts)、[型号目录](../../src/shared/modelCatalog.ts)。
- [无结果 / 重启 / 原 ID 查询回归](../../tests/service.test.ts)、[Seedream配置 / 超时 / OSS回归](../../tests/seedreamModels.test.ts)、[红色感叹号与动画释放](../../tests/nodeLoading.test.tsx)。
- 本地安装后核对两个用户指定任务失败、尝试与快照未变；人工验收见[清单](../manual-tests.md)211–213。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 无结果继续unknown和暂停Orb | 误导用户，与最新要求不符，不采用 |
| 本地failed、保留issued和原错误、不自动重提 | 可辨认失败且避免重复提交，采用 |
| 更正ID时重建模型或任务 | 丢失绑定与审计身份，不采用 |

## 后果

正面：用户能辨认失败并编辑新任务，原凭据和历史结果保持。

负面：本地失败仍不能证明供应商没有接收或扣费，须核对供应商记录。

## 可逆性与重审条件

回退使用本轮备份与兼容包，不能重建 / 重提旧任务。未来供应商提供按请求 ID 查询或幂等提交协议时，再审查自动核对机制。
