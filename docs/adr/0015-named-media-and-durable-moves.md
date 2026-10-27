# ADR-0015：按名称存储媒体与可恢复文件搬移

状态：已采纳

文档类型：解释；负责人：项目维护者；最近核对：2026-10-26。
记录日期：2026-10-26。替代 [ADR-0008](0008-streamed-local-media.md) 的文件布局 / 发布实现，延续 [ADR-0012](0012-retained-media-and-result-batches.md) 的历史保留原则。

## 背景与驱动因素

1. 用户要设置本地存储路径，按画布 / 资源名称查看文件，所有节点名称可修改。
2. 改名、切换磁盘和持续生成可能交错；路径变化不能破坏素材 ID 与已有引用。
3. SQL 与文件系统无法组成事务，必须记录目标与恢复清单并防止覆盖陌生文件。

## 决策

字节在用户设置的 Host 媒体根目录，数据库只存元数据 / hash / 实际位置。文件名安全化与身份后缀防碰撞；画布目录不含一级文件夹路径。canvas_assets 保持稳定 asset ID，节点 / 边引用 ID，不存用户路径。

接收流计数 / 检测 MIME / SHA-256 / fsync，发布先写 staging manifest，再 copy / hash / fsync / 不覆盖 hard-link / 目录 fsync，最后 ready；重启按 manifest 定位同一文件。已有 ready 文件必须核验字节，不能只凭“文件存在”判成功。

改节点名、画布名或根目录同事务写 file_operations / items，后台复制后按资产 row_version 和画布 layout_revision CAS 切实际指针。过期搬移标 superseded，失败仍读旧文件。来源文件、暂存和历史位置保留，当前不自动 GC。

目录手动输入 Host 绝对路径并验证写权限 / realpath；符号链接不能跳出画布根目录。官方 native / browse picker 已核对，当前未接入可选选择器；手动路径是无该能力时的完整设置方式。

## 备选方案

| 方案 | 不采用的原因 |
| --- | --- |
| 媒体 BLOB / Base64 存 SQLite | 放大 DB / WAL、备份和图读取 |
| 直接 rename 后改数据库 | 跨磁盘失败和崩溃窗口没有恢复事实 |
| 名称改完立刻删旧文件 | 可能删除仍可恢复的唯一可读来源 |
| 浏览器 directory picker 代替 Host 路径 | 浏览器可能在另一台机器，不等于宿主存储根 |

## 后果

正面：文件可按名称查看；路径变化不改引用；中断可恢复；不覆盖陌生文件；失败保留可读来源。

负面：复制峰值和保留历史增加磁盘占用；慢文件发布期间占用 Store 串行命令队列；不提供固定收尾时限或完整媒体解码；大小 / 时长元数据可能缺失。

## 可逆性与重审条件

存储驱动可替换，asset ID / file hash 要保留。需要自动 GC、低空间迁移、网络盘或跨 Harness 常驻服务时重审；GC 必须确认所有引用和恢复清单后才能删。

## 验证与证据

[files](../../src/host/media/files.ts)、[发布 / 搬移](../../src/host/sqlite-store.ts)、[HTTP 媒体](../../src/host/service.ts)；
[SQLite 测试](../../tests/sqlite.test.ts)覆盖连续改名 CAS、根目录切换 / 重启、旧字节保留、碰撞与越界 symlink；[服务测试](../../tests/service.test.ts)覆盖文件发布与关系提交间的恢复。真实跨盘拔盘 / ENOSPC 和长时间 I/O 仍由人工验收。
