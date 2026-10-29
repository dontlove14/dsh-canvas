# ADR-0016：宿主持久队列、任务目录 / 详情与凭据版本

状态：已采纳

浏览器隔离边界由[ADR-0058](0058-masked-settings-and-explicit-secret-reveal.md)补充：常规读取继续脱敏，用户主动点击可读取当前配置单字段；任务快照与凭据版本保持。

文档类型：解释；负责人：项目维护者；最近核对：2026-10-26。
记录日期：2026-10-26。替代 [ADR-0004](0004-host-owned-credentials.md)、[ADR-0006](0006-durable-task-recovery.md)、[ADR-0011](0011-polling-and-operation-concurrency.md) 的实现方式。

## 背景与驱动因素

1. 同步图片接口、异步视频接口对用户都应是后台任务，刷新 / 关面板不能打断已接受执行。
2. 任务目录仅存摘要，详情需要外部任务 ID、外部失败原因、成功和本地保存失败。
3. 模型 Key 改动不能改变旧任务身份；已发出但回执不明不能自动重新计费。

## 决策

CanvasRuntime 的 AbortController 与 active 步骤归 Host 插件，不继承 Request / Peer / React。task_catalog 与 task_details 1:1 同事务创建，前者存顺序、归属、状态 / 进度，后者存请求幂等、输入、凭据引用、阶段、lease / due、submit_issued、external_task_id、成功 / 失败、私有输出描述。

外部同步输出和异步 ID 均立即持久保存。明确外部失败记 provider 阶段 / 错误；外部完成写 external_completed_at，文件全部发布和关系齐全才写 success_at。本地保存失败单独记 storage；成功重试保留历史 attempt 错误。

已 issued 无 ID / 输出的任务进入 needs_attention，不自动重提；已知 ID 继续原查询，有输出继续原下载 / 发布。步骤领取受 runtime token 和 lease 控制；单 dataDir 使用 heartbeat 排他锁并兼容旧 PID 锁。生成队列接收上限 1000，due SQL 查询有界；导入 / 搬移不阻塞 generation 的到期扫描。

Harness 通过 ctx.credentials 插件 record 存新凭据版本；模型改 Key 新建 ref，已接受任务固定 ref 每步解析。SQL / 公共 DTO 不保存 Key。开发载体用权限受限 LocalVault；旧私有任务迁移时建立其原 Key 的独立版本。凭据记录不自动删除，避免误删历史恢复身份。

停止宿主先拒绝新请求，停止扫描、abort 可取消网络 / 文件流并等待收尾，再关 Worker / 释放锁。操作系统 fsync 等不保证固定时间内返回，不提前释放仍在写入的锁。停止 Harness / 禁用后台插件会停止本地执行，重启恢复；不部署额外守护进程。

## 备选方案

| 方案 | 不采用的原因 |
| --- | --- |
| 浏览器持有 Promise | 页面生命周期决定执行，无法满足刷新恢复 |
| jobs-local 直接作为持久队列 | 内存注册、不排队、不恢复，且具有 Session 所有权语义 |
| 将当前模型 Key 作为所有任务 Key | 编辑会改变原任务查询身份 |
| 立即独立后台服务 | 用户未要求跨 Harness 停机持续执行，增加部署 / 认证成本 |

## 后果

正面：统一后台接受边界；两表完整；外部 / 本地失败可解释；原 ID、输入和 Key 版本可恢复；请求断开不取消已接受生成。

负面：外部网络效果与数据库仍不是原子事务；unknown 需要人工核对；没有供应商取消 / exactly-once、轮询次数上限、自动凭据 GC；Host 停机期间不执行。

## 可逆性与重审条件

Runtime / Provider 可替换，必须保留 task ID、external ID 和原凭据引用。供应商提供幂等 / 取消 / 对账能力、队列负载增长或需要跨宿主停机执行时重审，不能靠盲目重试绕过。

## 验证与证据

[Runtime](../../src/host/runtime.ts)、[Vault](../../src/host/credentials.ts)、[生成接收](../../src/host/service.ts)；
[服务测试](../../tests/service.test.ts)覆盖外部错误、storage 失败、请求断开、原 Key / ID 重启、未知提交不重提、同次结果重试；[SQLite 测试](../../tests/sqlite.test.ts)覆盖 writer fence 与导入两表。
