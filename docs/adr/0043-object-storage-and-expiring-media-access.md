# ADR-0043：对象存储、单写入目标与临时媒体访问

状态：已采纳

waveform读取部分由[ADR-0045](0045-same-origin-waveforms-and-ratio-order.md)替代，其他规则保持。

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-28。
记录日期：2026-10-28。用户批准[实施方案](../proposals/object-storage-oss-v0.1.md)。替代 [ADR-0015](0015-named-media-and-durable-moves.md) 的本地持久媒体、路径设置和发布实现；替代 [ADR-0013](0013-sqlite-deltas-and-migration.md) 的旧源自动导入部分，保留 SQLite、增量事务及任务身份规则。

## 背景与驱动因素

1. 本机认证媒体地址不能被外部模型读取，需要私有对象存储上的临时 HTTPS 访问能力。
2. 首发阿里云 OSS，但业务必须隔离厂商协议，且当前新写入提供商有且仅有一个。
3. 大画布需要按需批量解析链接；页面链接过期不能破坏稳定素材身份或已接受任务。
4. 用户明确授权本次清空指定本机插件历史，不建设旧本地资产迁移；不得把清理扩大为正常启动行为或 Harness 数据清空。

## 决策

媒体原文件与派生封面 / 波形持久保存在 OSS。统一适配器负责 put、head、openRead、signRead、copy、deleteProbe；官方 ali-oss 6.23.0 只由 Host 使用。首期限定标准外网 HTTPS Endpoint 和 RAM AK，凭据保存到 Harness Vault，Client 仅收到掩码。

设置标题统一为“无限画布”，对象存储 / 模型设置 / TTS 设置分标签。保存并启用先在 SQL 串行队列外完成唯一前缀探测对象的上传、HEAD、签名 GET 比对与删除，再通过 revision CAS 切换 owner 的单活动指针；失败保留原配置。未配置时新建画布返回 `STORAGE_NOT_CONFIGURED` 和“请前往设置页面设置对象存储”，Client 两个入口均引导设置。新上传与生成同时检查。

停止使用的配置仍读取历史资源。新接受任务固定输出目标与凭据版本，切换不影响它们；相同 Bucket / 地域 / Endpoint / 前缀的密钥轮换更新历史读取凭据，并使链接缓存失效，原接受任务保持旧版本。配置定位字段变化建立新记录，不原地改写已有对象归属。

SQLite schema 3 保存 providerId、objectKey、SHA-256、ETag、可选 versionId 和业务元信息，不保存签名 URL。路径为 `prefix/文件夹名称__ID/画布名称__ID/资源名称__ID.ext`，未归档单独一层。改名和移动用同一提供商内 Copy、身份核验和 row / layout CAS 切换定位；保留旧对象，保证固定任务参考可读。派生定位保存在 asset_variants，搬移后按需重新生成。

接收 / 下载到受控 staging，登记固定对象与发布清单，云端上传在写队列外执行，HEAD / SHA 元信息 / ETag 核验后事务登记 ready。ACK 丢失恢复核对同一个 key；保存失败优先复用暂存结果，不重新下载过期输出、不重提付费模型。成功清理暂存。派生解码在系统临时目录，独立串行队列最多32个身份，失败冷却30秒，完成清理。

认证 media-urls 每批最多100项，只接受当前画布 assetId / variant；图读取不签名。Host 2048项有界缓存及同请求合并，Client 共享批量缓存。页面链接有效1小时，剩余不足5分钟刷新；恢复页面、播放 / seek / 预览前检查，更新源恢复播放时间 / 状态；加载失败仅强制刷新一次。media GET / HEAD 返回307及 no-store，HEAD独立签名，Range由OSS处理。

Runtime 在 `submit_issued` 前准备固定参考，失败不发送付费请求；URL协议使用新24小时签名。当前图片 multipart 和视频 data URL 协议保持，从 OSS 限额读取并核对字节，不擅自改 wire 格式。临时 URL 不写图、任务快照或 DB；外部模型收到的 URL 无法原地延长。

旧 schema 1 / 2 启动明确拒绝，绝不自动清空或导入旧 JSON。本次仅对 web / 3080 的插件业务数据执行停机一致备份后的限定重建，保留模型、TTS、Vault和profile / Harness对话。按[ADR-0021](0021-local-update-and-package-retention.md)检查、同包安装、重启、认证加载核验，失败恢复一致备份与上一已核验包。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 本地持久媒体 + 公网代理 | 增加公开服务与运行成本，未采用 |
| DB保存预签名URL / expiresAt | 临时凭证进入持久数据 / 备份；AK签名本地计算，收益有限，未采用 |
| 多提供商适配层 + 定位持久化 + 内存缓存 | 保持业务身份与厂商隔离，采用 |
| 首期浏览器直传OSS | 增加CORS / 完成校验契约，当前先复用Host流接收 |
| 自动迁移旧库或每次启动清空 | 不符合本次限定清理和其他安装的数据安全要求，未采用 |

## 后果

正面：资源可临时外网读取；不持久保存签名链接；切换与重试保持任务身份；云端慢上传不占全局写队列；本机仅保留未完成恢复暂存。

负面：依赖真实 Bucket 权限 / CORS及费用；名称改动复制和旧对象保留增加云端存储；派生首次读取需下载 / 解码；旧库需明确离线处理，不能原地升级后直接恢复旧媒体。URL有效期不能保证任意延迟的模型抓取。

## 可逆性与重审条件

新厂商通过适配器和新配置接入；首期无跨提供商迁移 / 自动对象GC。需GC时先核对图、任务参考与发布 / 搬移清单。签名时限、参考协议、直传、全ID目录、STS与云服务成本出现实测需求时重审。本次清理失败回退必须恢复完整旧库 / 媒体与匹配旧包，不能混合 schema。

## 验证与证据

[对象存储](../../src/host/object-storage/service.ts)、[阿里云适配器](../../src/host/object-storage/aliyun.ts)、[暂存发布 / 切换](../../src/host/sqlite-store.ts)、[schema](../../src/host/persistence/schema.sql)、[Service](../../src/host/service.ts)、[Runtime](../../src/host/runtime.ts)、[设置](../../src/client/ObjectStorageSettings.tsx)、[URL缓存](../../src/client/mediaUrlCache.ts)。

[存储故障与身份测试](../../tests/objectStorage.test.ts)、[设置与创建入口](../../tests/objectStorageUi.test.tsx)、[Client缓存](../../tests/mediaUrlCache.test.ts)、既有媒体 / TTS / Runtime回归及[编译产物核验](../../scripts/verify-artifact.mjs)使用隔离目录与离线替身。真实 Bucket、CORS、浏览器和模型效果尚待用户按[清单](../manual-tests.md)162–169验收，不能以替身测试代替。
