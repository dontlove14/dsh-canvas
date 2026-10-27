# ADR-0013：SQLite 增量事务、hash 链与只读旧源迁移

状态：已采纳

文档类型：解释；负责人：项目维护者；最近核对：2026-10-26。
记录日期：2026-10-26。替代 [ADR-0003](0003-local-single-writer-store.md)、[ADR-0007](0007-autosave-and-revision-conflicts.md) 的存储和保存实现。

## 背景与驱动因素

1. 节点、边、两端关系、任务及目录需要原子更新，全量 JSON 无法提供跨对象事务。
2. 高频拖动只应写改变的对象，后台上传也必须参与图修订，不能相互覆盖。
3. 旧 JSON、任务私有文件和媒体必须保持原字节及原 ID，迁移失败能续跑。

## 决策

采用 `node:sqlite` 单连接 Worker，最低 Node 22.13；WAL、FULL、FK、短读写事务。21 张表和 39 条显式索引以 [schema.sql](../../src/host/persistence/schema.sql) 为可执行事实，SQLite 自动索引另外计数。目录和图、任务、文件清单共用数据库。

客户端提交改变对象的规范化 SHA-256、删除 ID 和 baseRevision。宿主验证 hash、领域规则及修订，只更新不同对象的行。每个实际图变更写 receipt 与 hash 链：`SHA256({prevCommitHash, revision, changes})`；后台占位 / 素材绑定也写 host receipt。no-op 保存有请求回执但不推进图修订或 commit hash。

mutationId 与 request hash 约束重试身份。重复请求返回当前快照，并另带原回执的 revision / commitHash；不是重放一份旧快照。GET afterRevision 分页读取同一提交链。冲突保留客户端草稿，不采用最后写入覆盖。

旧源只读复制、校验、持久化图后记 graph-imported；任务凭据版本 / 私有输出恢复完并复核源 hash 才记 verified。续跑跳过已完成步骤，任何旧源变化停止启动，原 ID / 引用不变。

## 备选方案

| 方案 | 不采用的原因 |
| --- | --- |
| 继续多份全量 JSON | 无跨对象事务；高频全量写放大 |
| 官方 storage KV | 公开契约没有本项目需要的跨表 SQL 事务 |
| 原生扩展 SQLite 驱动 | 增加二进制构建 / ABI 部署成本；当前 Node 基线支持内置驱动 |
| CRDT 合并 | 单 owner 场景不需要，未定义跨用户任务权限 |

## 后果

正面：FK / CAS 失败整批回滚；请求幂等；对象按 hash 增量落盘；可追溯用户与后台图变更；迁移保留可回退源。

负面：启动仍加载全部画布、资产和生成任务投影到宿主内存；图 diff 仍遍历当前图，不能称为 O(增量) 全流程。Worker API 仍依赖 Node 演进；日志、历史无自动裁剪；文件 / 凭据与 SQL 不是同一事务。

## 可逆性与重审条件

驱动在 Database 边界可替换，Schema 切换须另迁移。内存 / 大图延迟超预算时重审投影和分页；双写者、多机或网络文件系统需求出现时重新设计锁与执行归属。旧版只允许通过离线备份回退，不对同一数据目录双写。

## 验证与证据

[sqlite-store](../../src/host/sqlite-store.ts)、[Worker](../../src/host/persistence/worker.mjs)、[v2 契约](../../src/shared/v2.ts)、[保存 hook](../../src/client/useCanvas.ts)。
[SQLite 测试](../../tests/sqlite.test.ts)覆盖仅改动行、hash 链、no-op / replay、冲突、FK / CAS 回滚、token fencing、迁移凭据故障续跑与源不变。完整断电和大图负载仍须人工验证，见[验证记录](../verification.md)。
