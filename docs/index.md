# 文档导航与维护约定

文档类型：参考；负责人：项目维护者；最近核对：2026-10-26；复核周期：每次发布，最迟每月一次。

本目录描述 SQLite / 多画布版本的当前实现。ADR-0001–0012 保留首版补录，0013–0017 记录存储 / Runtime 实施，0018 记录项目列表与编辑器导航；历史实现已标注替代关系。

设计基线：[目标架构](proposals/canvas-plugin-architecture-v0.1.md)、[SQLite 设计](proposals/sqlite-canvas-storage-v0.2.md) 已标注实施与差异；实际职责、DDL / API 以当前架构与数据参考为准。官方用法与反例见 [ADR-0017](adr/0017-harness-official-cases-and-badcases.md)。[存储 v0.1](proposals/sqlite-canvas-storage-v0.1.md) 保留历史。

代码与检查脚本链接面向项目源码目录；安装包只携带运行产物和说明文档，查看源码证据或执行开发检查需使用完整项目。

## README 与 ADR 的分工

| 内容 | 权威维护位置 | README 的处理 |
| --- | --- | --- |
| 项目用途、前提、首次启动与最短使用路径 | [README](../README.md) | 保留可直接执行的入门步骤 |
| 用户行为、状态、删除 / 引用 / 保存规则、功能边界 | [业务与功能](business.md) | 只保留影响首次使用的摘要和链接 |
| 当前模块职责、依赖方向、数据流 | [架构说明](architecture.md) | 链接 |
| 精确字段、接口、状态码、持久布局 | [数据与接口参考](data-api.md) | 链接 |
| 协议能力、请求 / 响应映射、格式限制 | [模型协议参考](providers.md) | 概述支持范围后链接 |
| 安装升级、配置项、备份恢复、排障 | [运行指南](operations.md) | 保留首次启动；完整操作步骤维护在指南 |
| 选型原因、驱动因素、备选方案、代价、重审条件 | [ADR](adr/index.md) | 链接；不展开论证 |
| 已验证证据、未验证项、已知实现缺口 | [验证记录](verification.md) | 一句说明验证边界后链接 |
| 用户执行的验收步骤和预期 | [手动验收](manual-tests.md) | 链接 |

README 回答“这是什么，怎样开始”；ADR 回答“为什么这样决定”。架构说明回答“现在怎样组成和运行”。操作步骤、参数字典和测试清单不放进 ADR；ADR 通过链接引用它们。

## 阅读路径与维护责任

所有文档当前由项目维护者负责；修改相关代码的人应在同一变更中更新文档，维护者复核。以下“权威”指供人阅读的规范位置；可执行事实仍以对应代码和测试为准。

| 文档 | 类型 / 主要读者 | 复核周期 | 提前复核的触发条件 / 代码证据 |
| --- | --- | --- | --- |
| [README](../README.md) | 教程；新用户 / 开发者 | 每次发布 | 包版本、CLI、首次使用变化；[package.json](../package.json) |
| [业务与功能](business.md) | 参考；产品 / 开发 / 验收 | 每次功能变更，最迟每月 | 节点、引用、任务与交互变化；[Canvas](../src/client/Canvas.tsx)、[contracts](../src/shared/contracts.ts) |
| [架构说明](architecture.md) | 解释；开发者 | 每次边界变更，最迟每月 | 模块、生命周期与依赖变化；[宿主入口](../src/host/index.ts)、[服务](../src/host/service.ts) |
| [数据与接口](data-api.md) | 参考；集成 / 开发者 | 每次契约变更，最迟每月 | Schema、路由、持久版本变化；[contracts](../src/shared/contracts.ts)、[Store](../src/host/store.ts) |
| [模型协议](providers.md) | 参考；接入 / 开发者 | 每次适配器变更，最迟每月 | 能力、供应商接口、错误映射变化；[Providers](../src/host/providers.ts) |
| [运行指南](operations.md) | 操作指南；使用 / 运维 | 每次发布 | profile、配置、打包、存储路径变化；[配置](../src/host/index.ts)、[开发载体](../src/dev/server.ts) |
| [验证记录](verification.md) | 参考；交付 / 维护者 | 每次交付 | 新测试、真实联调、性能证据或缺口修复；[服务测试](../tests/service.test.ts)、[GPU 测试](../tests/gpu.test.ts) |
| [手动验收](manual-tests.md) | 操作指南；测试者 | 每次功能变更 | 控件、状态、失败处理、目标浏览器变化；[Canvas](../src/client/Canvas.tsx) |
| [ADR 索引与记录](adr/index.md) | 解释；决策者 / 开发者 | 每次决策变化；发布时检查有效性 | 决策被替代、约束变化或重审条件达成 |

每份文档顶部标注类型、负责人和最近核对日期。周期 / 触发条件可在此集中维护；事实变化时立即更新，不能等到周期到期。验证记录中的“未验收”必须有实际结果后才能改为通过。

## 权威来源与历史材料

1. 类型与输入边界：[contracts.ts](../src/shared/contracts.ts)；宿主执行契约：[service.ts](../src/host/service.ts)、[store.ts](../src/host/store.ts)、[providers.ts](../src/host/providers.ts)。
2. 用户可见行为：[项目列表](../src/client/ProjectList.tsx)、[Canvas.tsx](../src/client/Canvas.tsx)、[Settings.tsx](../src/client/Settings.tsx)、[useCanvas.ts](../src/client/useCanvas.ts)；打包和运行：[scripts](../scripts/build.mjs)、[package.json](../package.json)。
3. `DeepSeek-Harness-Canvas-PRD-v0.1.html` 是项目初始方案的历史材料，保留原稿。它不替代当前实现参考，也不代表其中全部设想已经交付。

正文出现矛盾时，先核对代码和测试，再修正文档；不要用旧 PRD 或旧 ADR 推断当前行为。持久格式中的 `version: 1` 是数据契约版本，不代表另有一个待维护的旧版画布模式。

## 决策更新与避免重复

- 一个事实维护在上表指定位置；其他文档使用摘要和相对链接。配置默认值只在运行指南列完整表，协议能力只在协议参考列完整表。
- 新决策使用连续 ADR 编号和“记录日期”。尚未落地的方案标记“提议”，实施后改为“已采纳”；本次补录统一标记“已采纳（补录）”，写明补录 / 核对日期和证据。
- 取代已采纳决策时，新建 ADR，旧记录标记“已替代”并链接新记录；保留原背景、备选项和后果。仅纠错或补充证据可直接更新原记录。
- 每条 ADR 至少包括两个驱动因素、明确决策、真实可行备选项、正负后果、可逆性 / 重审条件、负责人和验证证据。

## 文档检查

运行 `npm run docs:check` 检查 README / docs 的本地链接与锚点、文档元数据、ADR 编号 / 结构 / 索引完整性。该检查也纳入 `npm run check`。

脚本见[check-docs.mjs](../scripts/check-docs.mjs)。它检查文档结构，不能判断内容是否符合业务事实；语义核对仍由变更作者和维护者完成。
