# SQLite 多画布、媒体文件与后台任务设计 v0.2

状态：已按授权实施核心方案；以下保留批准时设计稿。取代 [v0.1 草案](sqlite-canvas-storage-v0.1.md)。

文档类型：解释 / 设计参考；负责人：项目维护者；最近核对：2026-10-26。
需求、宿主版本或实现改变时复核。实际 DDL / API 以[数据契约](../data-api.md)、[schema.sql](../../src/host/persistence/schema.sql)和 [ADR-0013](../adr/0013-sqlite-deltas-and-migration.md) 至 ADR-0017 为准，不能将设计列名当成实际列。

实施核对（2026-10-26）：已建21表、39条显式索引，实现一级目录、图增量 / hash / 回执、文件发布 / 搬移、生成 / 导入两表与宿主恢复。实际差异：单 owner 使用固定 local-owner（dataDir 隔离），应用 / 仓储暂集中 Service / Store；输入 snapshot 兼容旧 DTO，参考关系另表；未自动删除搬移来源和 staging；picker 采用手动 Host 绝对路径输入；软删除画布在删空文件夹时解除旧 folder_id；完整投影仍在宿主内存。原因 / 风险见对应新 ADR。

本次修订：任务按目录 / 详情 1:1 拆表，外部任务 ID、成功结果与失败原因归详情；插件装配、模块依赖和官方依据见[目标架构设计](canvas-plugin-architecture-v0.1.md)。

## 1. 业务形态与本次修正

一个用户可以创建多张画布，**每张画布就是一个项目**。多个画布可以放入文件夹管理；文件夹和画布都能重命名。没有独立 `projects` 表，没有海报 / 图片 / 视频项目分类，没有 Harness 工作区这一层业务分组。

```text
用户
  ├─ 文件夹 A
  │   ├─ 画布甲（项目）
  │   └─ 画布乙（项目）
  └─ 画布丙（项目，未放入文件夹）
```

| 用户操作 | 拟议规则 |
| --- | --- |
| 添加生成节点 | 菜单保留现有图片生成、视频生成入口；没有空的图片 / 视频 / 音频资源节点入口 |
| 上传媒体 | 点击上传或拖拽到画布；识别文件类型，自动创建相应资源节点；多文件逐个建立独立上传记录 |
| 上传中的节点 | 先显示上传占位节点和进度；完成本地接收后由后台导入，成功后显示媒体 |
| 修改名称 | 文件夹、画布、上传资源节点、生成节点都可改名；资源 / 生成节点统一以 `canvas_nodes.title` 为名称来源 |
| 存储设置 | 用户选择运行宿主电脑上的媒体根目录；最终按“画布名称 / 资源或生成节点名称”保存文件 |
| 生成任务 | 无论供应商接口同步还是异步，页面提交后都进入持久任务队列 |
| 刷新 / 关闭画布页面 | 已接收的任务继续由宿主执行；再次打开从数据库读取进度和结果 |
| 移动画布到文件夹 | 只修改目录归属；逻辑文件夹不增加磁盘目录层级 |
| 删除节点 / 画布 | 未结束的生成 / 导入任务或正在接收的上传会阻止删除；名称修改可以继续 |
| 删除文件夹 | 初期仅允许删除空文件夹；先移出内部画布，包括逻辑删除但仍关联的画布 |

内部仍保留五种节点类型：图片生成、视频生成、图片资源、视频资源、音频资源。资源类型用于上传建节点和旧数据读取，移除的是手动创建空资源节点的入口。当前没有音频生成协议，本设计不顺带新增音频生成。

本稿继续采用一层文件夹。每张画布最多属于一个文件夹，`folder_id=NULL` 表示根目录。同用户文件夹名称唯一，同文件夹活动画布名称唯一，根目录活动画布名称也唯一；不同文件夹可以有同名画布。节点名称允许重复。

名称统一 trim、NFC 规范化、非空，建议不超过 160 字符；业务查重采用 BINARY 比较。磁盘目录 / 文件另用安全路径规则，不要求业务名称适合直接作为路径。

`owner_id` 来自宿主身份适配层；本机单用户模式使用数据目录中的稳定标识。客户端不能自行传入 owner_id 来切换用户。本稿不引入账户系统，也不宣称当前插件已经有多租户能力。

## 2. 存储边界与文件命名

### 2.1 数据库与媒体根目录分开

```text
插件 dataDir/                     插件管理的数据目录
  canvas.sqlite                  目录、图、素材元信息、任务与恢复清单
  models.json                    现有模型配置，暂不改造为模型表
  staging/                       上传 / 结果下载的受控临时文件

Harness 凭据提供方/               使用 ctx.credentials 管理插件凭据版本
  <提供方拥有的受限存储>          任务只记录引用；不自行猜测宿主存储路径

用户选择的媒体目录/
  画布甲/
    角色参考.png
    背景视频.mp4
    配音.wav
    场景生成__任务001__结果01.png
    场景生成__任务001__结果02.png
    场景生成__任务002__结果01.png
  画布乙/
    产品图片.png
```

`任务001` 是便于说明的批次后缀，正式文件后缀使用持久任务序号和结果顺序。文件扩展名依据识别出的真实格式生成，不盲信上传文件扩展名。

用户改变媒体路径不直接改写 SQLite / 凭据目录。首次默认媒体根目录可以是 `dataDir/media`；配置新路径后，新画布和新文件使用新目标，存量媒体由持久搬移操作逐份迁移。界面区分“目标目录已设置”与“历史文件搬移完成”，不假装设置保存就已搬完。

这里的“本地”指运行 Harness 宿主的电脑。如果浏览器连的是远端 Harness，路径属于远端宿主；网页不能把远端生成文件直接写入浏览器所在电脑的任意目录。

### 2.2 名称、身份、实际路径各有用途

| 内容 | 权威字段 / 规则 |
| --- | --- |
| 画布身份 | `canvases.id`，改名后不变 |
| 节点 / 素材身份 | node_id / asset_id，改名、搬移、重新打开后不变 |
| 用户可改的资源名称 | `canvas_nodes.title`；上传初值为去扩展名的原文件名 |
| 上传原始文件名 | `canvas_assets.original_filename`，保留导入来源，不随改名覆盖 |
| 目标画布目录 | `canvases.target_storage_id` 指向已预留的 `canvas_storage_locations` |
| 当前实际文件 | `canvas_assets.storage_id + file_name`，JOIN 存储位置与根目录得到路径 |
| 历史名称 | 素材保留 `name_snapshot`；来源节点删除后仍可展示历史结果 |
| 边 / 任务的引用 | 只保存 asset_id，名称和路径不作为引用键 |

普通上传按 `根目录/安全画布名/安全资源名.ext` 保存。重复导入、同名节点、已有磁盘文件等发生冲突时，加稳定素材短 ID 后缀，并在必要时扩展长度，不覆盖其他文件。生成结果始终带批次 / 结果序号，避免再次生成覆盖历史结果。

不同逻辑文件夹下可能有同名画布，而磁盘没有文件夹层级：第二个冲突目录使用 `画布名__画布短ID/`。路径后缀只用于消除冲突，不产生项目类别。

路径组件要过滤分隔符、控制字符、`.` / `..`、平台保留名称、尾部空格 / 点，限制组件 UTF-8 字节数；截断时保留后缀和扩展名。保存 `directory_key` / `file_name_key`，以统一 Unicode 规范化和保守大小写折叠判断路径冲突；不依赖 SQLite 默认 NOCASE 处理 Unicode。

根目录由宿主规范化并验证权限；文件名由宿主产生。真实目录必须在配置根目录内，防止通过符号链接逃逸。预留数据库路径后仍使用不覆盖现有文件的落盘方式，外部新建文件可能造成冲突，需要重新分配后缀。

### 2.3 重命名与存储路径调整

| 操作 | 数据库先提交的变化 | 后台文件操作 |
| --- | --- | --- |
| 文件夹改名 | name、meta_revision、content_hash | 无；文件夹只是分类 |
| 画布改名 | name、meta_revision、layout_revision、新目标存储位置、搬移记录 | 把该画布媒体逐份搬到新名称目录 |
| 上传资源节点改名 | title、name_revision、节点 hash、图增量、搬移记录 | 改该节点拥有的资源文件名 |
| 生成节点改名 | 同上 | 改该节点已落盘的历史输出文件前缀，保留批次 / 结果后缀 |
| 改媒体根目录 | 用户存储设置版本、各画布目标位置与 layout_revision、搬移记录 | 按画布迁移已有文件；跨磁盘使用复制 |
| 改名期间新结果完成 | 任务快照不变；输出使用当前名称和当前目标目录 | 与搬移协调，不发布到过期路径 |

改名的数据库 ACK 后界面立即显示新名称，文件搬移可以稍后完成。期间数据库保留实际可读位置；界面明确显示搬移中或搬移失败。不能直接根据最新画布名 / 节点名猜测实际文件路径。

同画布共享一个素材时，只由其原始名称归属节点改名驱动物理改名；其他引用节点的标题不会抢着修改同一个文件。重新导入和再次生成创建新 asset_id / 新文件；素材字节不可变。名称 / 路径改动不改变 file_hash，也不改旧连线或任务引用。

## 3. 表结构总览

一个 dataDir 使用一个 SQLite 库；按照 canvas_id 组织图、媒体、任务。根目录设置、路径搬移和队列都属于宿主数据，不由 React 生命周期维护。

```text
folders ──< canvases ──< canvas_nodes
                    └─< canvas_edges
canvas_edges ──< edge_node_relations >── canvas_nodes

canvases ──< canvas_storage_locations >── storage_roots
canvas_assets ──实际位置──> canvas_storage_locations
canvas_nodes / canvas_edges ──asset_id──> canvas_assets

task_catalog ──1:1── task_details
             ├─< task_references >── canvas_assets
             ├─< task_outputs   >── canvas_assets
             └─< task_attempts
upload_sessions ──接收完成──> task_catalog(kind=import) + task_details
file_operations ──< file_operation_items ──> canvas_assets
```

| 分组 | 表 | 作用 |
| --- | --- | --- |
| 业务核心，五张 | folders、canvases、canvas_nodes、canvas_edges、edge_node_relations | 文件夹、画布、节点、边、端点关系独立存储 |
| 增量保存 | canvas_state、canvas_mutations、catalog_mutations | 视口、图增量与请求回执、目录 / 设置 CRUD 幂等 |
| 路径与素材 | storage_roots、owner_settings、canvas_storage_locations、canvas_assets | 用户选目录、预留画布目录、实际文件定位和媒体元信息 |
| 上传与任务 | upload_sessions、task_catalog、task_details、task_attempts、task_references、task_outputs | 轻量任务目录、详情 / 恢复、输入与输出；两张任务主表 1:1 |
| 文件操作 | file_operations、file_operation_items | 改名 / 搬移的持久操作与逐文件断点 |
| 旧数据导入 | migration_imports | 源文件映射、hash、checkpoint 和核验 |

这些辅助表用于完成文件落盘、恢复和一致性，不是新业务项目类型。下面是字段 / 约束设计，尚不是可执行迁移脚本。

### 3.1 核心五张表

| 表 | 字段与类型 | 主键 / 关键约束 |
| --- | --- | --- |
| `folders` | id TEXT、owner_id TEXT、name TEXT、meta_revision INTEGER、content_hash TEXT、created_at / updated_at INTEGER | PK(id)；UNIQUE(owner_id,id)；同用户名称唯一；无 parent_id |
| `canvases` | id TEXT、owner_id TEXT、folder_id TEXT NULL、name TEXT、meta_revision INTEGER、graph_revision INTEGER、layout_revision INTEGER、target_storage_id TEXT、content_hash TEXT、commit_hash TEXT、min_replay_revision INTEGER、created_at / updated_at INTEGER、deleted_at INTEGER NULL | PK(id)；UNIQUE(owner_id,id)；根目录 / 文件夹内活动名称分别唯一；同用户文件夹 FK；目标存储位置必须属于本画布 |
| `canvas_nodes` | canvas_id / id TEXT、kind TEXT、title TEXT、name_revision INTEGER、position_x / y REAL、model_id TEXT NULL、prompt TEXT、params_json TEXT NULL、asset_id TEXT NULL、selected_result_id TEXT NULL、sort_order INTEGER、row_version INTEGER、content_hash TEXT、created_at / updated_at INTEGER | PK(canvas_id,id)；canvas FK；两个素材引用均为同画布复合 FK；五种 kind；允许上传占位资源 asset_id=NULL |
| `canvas_edges` | canvas_id / id TEXT、asset_id TEXT、sort_order INTEGER、row_version INTEGER、content_hash TEXT、created_at / updated_at INTEGER | PK(canvas_id,id)；canvas FK；同画布素材 FK；不重复存 source / target |
| `edge_node_relations` | canvas_id TEXT、edge_id TEXT、role TEXT、node_id TEXT、port_key TEXT、content_hash TEXT | PK(canvas_id,edge_id,role)；CHECK(role IN source / target)；同画布 edge / node FK；删边级联关系，删节点 RESTRICT |

时间字段采用 UTC 毫秒 INTEGER；版本、队列序号和结果顺序为非负整数，宿主检查 JS 安全整数范围。params_json 做 JSON 和领域校验，坐标 / zoom 必须有限；hash 为 SHA-256 的 64 个十六进制字符。

画布名称 / 文件夹变化更新 meta_revision；图内容更新 graph_revision；目录目标变化更新 layout_revision，供文件操作隔离过期结果。节点 name_revision 只在标题变化时递增。这些版本互不冒充：文件路径搬移不导致节点位置重写。

目标存储位置复合 FK `(id,target_storage_id)` → `canvas_storage_locations(canvas_id,id)`。画布与初始存储位置循环关联，正式 DDL 采用延迟 FK，在同一事务创建两行再绑定；不把一半创建的画布发布到列表。

所有素材 FK 指向 `(canvas_id,id)`。模型仍沿用 models.json，没有虚构 model 外键。生成节点 asset_id 为 NULL；selected_result_id 必须属于该节点任务输出，宿主在事务内检查。资源节点有媒体后才可作为连线来源。

每条边必须有 source、target 两条关系。PK + role CHECK 只能保证每种角色最多一行，“恰好两行”由宿主在写事务结束前验证。边与两条关系一起提交；删除节点先删除全部关联边。

无环、目标为生成节点、来源素材归属、同目标不重复输入相同素材，均为涉及多表的业务约束，在单宿主事务内验证；不能声称一个单表 UNIQUE 能覆盖它们。

### 3.2 增量保存与目录回执

| 表 | 字段 | 主键 / 约束 |
| --- | --- | --- |
| `canvas_state` | canvas_id TEXT、viewport_x / y / zoom REAL、row_version INTEGER、content_hash TEXT、updated_at INTEGER | PK(canvas_id)，每画布一行 |
| `canvas_mutations` | canvas_id / mutation_id TEXT、actor TEXT、request_hash TEXT、base_revision / committed_revision INTEGER、has_changes INTEGER、prev_commit_hash / commit_hash TEXT、changes_json TEXT、created_at INTEGER | PK(canvas_id,mutation_id)；实际变更 revision 唯一；actor 区分用户 / 上传 / 任务 |
| `catalog_mutations` | owner_id / request_id TEXT、operation TEXT、request_hash TEXT、entity_type / entity_id TEXT、result_json TEXT、created_at INTEGER | PK(owner_id,request_id)；为文件夹 / 画布 CRUD、改存储设置保留 ACK |

catalog_mutations 不混入 graph_revision。request_hash 覆盖规范化请求，重复 ID + 相同请求返回原 ACK；相同 ID + 不同内容拒绝。图回执清理水位见第 7 节；目录回执初期保留，未来若引入清理需先定义请求过期协议。

### 3.3 路径与素材

| 表 | 字段 | 主键 / 约束 |
| --- | --- | --- |
| `storage_roots` | id / owner_id TEXT、absolute_path TEXT、path_key TEXT、state TEXT、created_at INTEGER | PK(id)；UNIQUE(owner_id,id)；UNIQUE(owner_id,path_key)；state=available / unavailable |
| `owner_settings` | owner_id TEXT、active_root_id TEXT、storage_revision INTEGER、content_hash TEXT、updated_at INTEGER | PK(owner_id)；同用户 root FK |
| `canvas_storage_locations` | canvas_id / id / root_id TEXT、relative_dir TEXT、directory_key TEXT、created_at INTEGER | PK(canvas_id,id)；root / canvas FK；UNIQUE(root_id,directory_key) |
| `canvas_assets` | canvas_id / id TEXT、kind TEXT、origin_kind TEXT、original_filename TEXT NULL、name_source_node_id TEXT NULL、name_snapshot TEXT、storage_id TEXT NULL、file_name / file_name_key TEXT NULL、mime TEXT NULL、bytes INTEGER NULL、file_hash TEXT NULL、file_state TEXT、width / height INTEGER NULL、duration REAL NULL、row_version INTEGER、content_hash TEXT、created_at / updated_at INTEGER | PK(canvas_id,id)；同画布 storage FK；UNIQUE(canvas_id,storage_id,file_name_key) WHERE storage_id IS NOT NULL；CHECK(kind IN image / video / audio) |

storage_roots 的路径登记后不原地改成另一个目录，改设置使用另一个 root_id。available 是最近检测状态，真实 IO 仍可能失败。初次设置与改设置先验证宿主路径与权限，再通过目录事务登记设置、目标位置和文件操作；存量扫描可分批，不在一个大事务复制文件。

canvas_storage_locations 同时预留当前目标和历史实际目录，避免不同画布迁移途中占用对方目录。旧位置在素材或搬移清单仍引用时保留；不是只有最新目标才参与目录冲突检查。

素材实际路径按以下 JOIN 唯一解析，不在节点 / 边里复制：

```text
asset.storage_id
  → storage_location.root_id + relative_dir
  → storage_root.absolute_path / relative_dir / asset.file_name
```

这等价于在 SQLite 保存“根目录 ID + 相对路径”。不存在根据当前标题重建路径的隐式规则。根目录、存储位置的删除使用 RESTRICT，来源节点 ID 仅做溯源，历史素材不因节点删除级联消失。

file_state=staging / ready / missing。预登记输出可以是 staging，路径 / MIME / hash 可暂为 NULL；ready 必须具备实际位置、识别 MIME、bytes、file_hash。missing 保留已知元信息和引用，不能伪造成 ready。

file_hash 校验不可变文件字节；content_hash 校验素材元信息。流写或迁移时核验文件，不在拖动节点、每次 Range 播放时重读整个视频算 hash。不按 hash 自动去重，不跨画布共享文件。

### 3.4 上传会话

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| canvas_id / id | TEXT | PK(canvas_id,id)，上传会话稳定 ID |
| node_id | TEXT | 自动创建的资源节点 ID |
| request_id / request_hash | TEXT | 开始上传幂等请求及摘要 |
| status | TEXT | receiving / received / importing / completed / interrupted / failed |
| original_filename / expected_kind | TEXT | 原名和经校验的媒体类别 |
| staging_key | TEXT | dataDir/staging 内的受控临时对象 ID |
| expected_bytes / received_bytes | INTEGER | 大小校验与接收进度；不能把进度冒充完整文件 |
| file_hash | TEXT / NULL | 完整文件接收后产生的 SHA-256 |
| task_id | TEXT / NULL | 完成接收后创建的 import 任务 |
| row_version / created_at / updated_at | INTEGER | 并发与恢复字段 |

UNIQUE(request_id)，并校验请求包含的画布归属；task_id 使用同画布 FK 指向 task_catalog。node_id 为历史线索，活动会话存在时宿主阻止节点删除，不为历史会话加级联删除节点规则。

开始上传时，以带 base_revision 的幂等事务创建占位节点、upload_session 和一条图增量。文件完整落入 staging、校验、持久化后，同一 SQLite 事务登记 received、创建 task_catalog(kind=import) / task_details、绑定 task_id。导入工作不依赖浏览器等待 HTTP 连接。

接收结束写持久完整标记；若完整文件已落盘但 received 事务尚未提交就崩溃，启动按会话、完整标记和文件校验补齐入队。没有完整标记的临时字节不能作为完整文件发布。

页面刷新**可能打断尚未传完的上传字节**；没有收到宿主的完整文件不可能凭队列继续。启动对账把这种会话标成 interrupted，保留占位并允许重新选择文件。完整 staging 已接收后，即使 ACK 丢失，重试按会话 ID 返回原 task_id，不重复创建资源节点。

默认不新增分片 / 断点续传协议。多文件上传分别完成，失败文件不回滚已经成功的其他文件。

## 4. 通用持久任务队列

### 4.1 `task_catalog`：任务目录表

图片、视频生成与媒体导入统一入队，两个任务主表在调用模型之前同事务提交。目录表只保存任务身份、归属、目录展示、列表排序和状态，不保存提示词 / 参数、外部回执、成功详情、失败原因或执行租约。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| canvas_id / id | TEXT | PK(canvas_id,id)，任务稳定 ID |
| node_id | TEXT | 所属节点；终态历史不因节点删除级联消失 |
| kind / media_kind | TEXT | kind=generate / import；media_kind=image / video / audio |
| name_snapshot | TEXT | 提交时任务目录名称；节点还存在时可以显示当前节点名称，删除后保留历史名 |
| queue_seq | INTEGER | 全库单调递增且唯一的入队序号；在单写事务分配，不用时间戳排序 |
| status | TEXT | 用户状态唯一来源；不在详情再存一份重复 status |
| progress | INTEGER / NULL | 供应商进度或阶段进度；不能提前显示保存完成 |
| created_at / started_at / updated_at / finished_at | INTEGER / NULL | 入队、开始、状态变化、终态时间 |
| row_version | INTEGER | 任务状态并发版本 |

canvas FK；UNIQUE(queue_seq)。node_id 由提交事务验证存在和类型，历史保留采用软关联；禁止删除具有未结束任务的节点。一个节点最多一项未结束任务，通过部分 UNIQUE 约束，不只靠页面禁用按钮。

### 4.2 `task_details`：任务详情表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| canvas_id / task_id | TEXT | PK(canvas_id,task_id)，FK → task_catalog(canvas_id,id)，最多一条详情 |
| request_id / request_hash | TEXT | 生成提交幂等 ID 与摘要；导入由会话派生；UNIQUE(request_id) |
| snapshot_json / snapshot_hash | TEXT | 不可变模型协议、端点、参数、提示词及能力快照；不含 API Key / 重复输入 ID |
| binding_snapshot_json | TEXT | 提交时 asset_id / selected_result_id，发布时检查当前选择 |
| credential_ref | TEXT / NULL | ctx.credentials 中插件拥有的不可变凭据版本记录引用；每步按该固定引用解析 |
| upload_session_id | TEXT / NULL | import 来源；同画布 upload_session FK |
| phase | TEXT | submit / wait_provider / download / verify / publish |
| next_run_at | INTEGER / NULL | 下次执行时间；非 NULL 表示待调度，终态 / 暂停态清 NULL |
| claimed_by / lease_until | TEXT / INTEGER NULL | 当前执行实例和租约 |
| lease_token / attempt_count | INTEGER | 每次领取递增 token；步骤尝试计数，不等于重复生成次数 |
| phase_started_at / deadline_at | INTEGER / NULL | 阶段时间和等待期限 |
| external_provider_key | TEXT / NULL | 协议 / 端点 / 模型的稳定标识；不含密钥，为外部 ID 提供命名空间 |
| external_task_id | TEXT / NULL | **异步外部模型返回的任务 ID**；收到后立即持久化，恢复查询使用此 ID |
| external_status | TEXT / NULL | 外部服务最后确认的原始状态，由适配器映射到本地状态 |
| external_request_id | TEXT / NULL | 外部响应 / 跟踪请求 ID；与 external_task_id、插件 task_id 不混用 |
| external_completed_at / external_failed_at | INTEGER / NULL | 确认外部成功 / 失败的时间；接口未给时间时记录本地观察时间 |
| external_error_code / external_error_message | TEXT / NULL | 外部服务明确返回的错误码与失败原因，脱敏 / 截断后保留 |
| external_http_status | INTEGER / NULL | 最后一次有意义的失败 HTTP 状态；不存在则 NULL |
| success_at | INTEGER / NULL | 本地所有输出核验落盘且关联成功的时间，与外部完成分开 |
| success_summary_json | TEXT / NULL | 有界成功信息：输出数量、总字节及供应商确实返回的用量等；不重复保存 asset_id 数组 |
| last_failure_source / last_failure_phase | TEXT / NULL | provider / transport / validation / storage / runtime，以及发生阶段 |
| last_failure_code / last_failure_message / last_failure_at | TEXT / INTEGER NULL | 最近一次失败的统一原因与时间；成功恢复后仍可保留为历史，不改变当前目录状态 |
| provider_receipt_json | TEXT / NULL | 有界且脱敏的外部回执摘要；私有恢复字段不进入公开 DTO |
| output_descriptors_json | TEXT / NULL | 私有恢复描述的唯一来源：输出顺序及原下载 URL / staging key，不内嵌媒体字节，不重复结果 asset_id 列表 |
| row_version / updated_at | INTEGER | 详情并发版本与更新时间 |

目录 / 详情必须 1:1，在一次事务里创建。详情 PK + FK 只保证“最多一条且不孤立”，不能保证每个目录行必有详情；事务前校验和启动核验补足此不变量，不允许只创建目录就返回 202。

external_task_id 只有外部接口返回后才有值，同步接口可一直为 NULL；NULL 不能证明请求尚未发出，还需查 issued 标记。不对外部 ID 建全局 UNIQUE，不同供应商可能使用相同 ID；按 external_provider_key + external_task_id 定位。

任务详情需要的全部成功输出通过 task_outputs 读取；success_summary_json 只存摘要。明确失败保存供应商原因；网络超时只记录 transport 原因，不伪造成外部任务失败。供应商已成功、本地保存失败时同时保留外部成功与本地 storage 失败，目录显示 save_failed。

例如外部返回 `error.code=quota_exceeded`、`error.message=余额不足`：详情记录原错误码 / 原因，适配器补充 last_failure_source=provider；HTTP 200 中的异步失败同样落库，不要求先出现非 2xx HTTP。原始响应里的密钥、鉴权头、签名 URL 不写入公开错误；下载需要的原签名 URL 可在受限 output_descriptors_json 中保留，接口 / 日志必须剔除。同步返回媒体字节先落 staging，不塞进数据库 JSON。

### 4.3 状态与两表事务

| status | 用户可见含义 | 调度 / 删除规则 |
| --- | --- | --- |
| queued | 排队中 | 到期可领取；尚未产生外部效果可以取消 |
| running | 执行中 / 等供应商结果 / 保存中 | 根据 phase 执行；轮询间隙释放执行租约 |
| retry_wait | 可安全恢复的步骤等待重试 | 到期再执行对应步骤 |
| save_failed | 完整媒体已接收或模型已产出，本地保存失败 | 保留原输出清单；恢复保存，不重新生成 |
| needs_attention | 提交结果不明、恢复凭据缺失等 | 停止自动执行，明确提示待处理 |
| succeeded | 完成 | 所有输出已核验落盘并绑定输出表 |
| failed | 明确失败 | 只用于已确认失败，不把不明结果当失败 |
| canceled | 已取消 | 未提交任务可直接取消；已提交任务须有供应商取消 / 未接受的确认 |
| abandoned | 用户结束本地等待 | 保留原历史与不明外部效果；不声称取消远端任务，不自动新建任务 |

前五种状态均为未结束任务。正在接收的上传还没入任务表，删除规则另查 upload_sessions。needs_attention / save_failed 仍锁住节点，避免删掉恢复入口；用户沿用现有明确结束本地等待的操作后可变成 abandoned，不能由 lease 到期自动改成 canceled / abandoned。已放弃任务的旧执行器也不得继续绑定节点。

生成 phase 为 submit → wait_provider（若有）→ download → verify → publish；同步图片接口跳过 wait_provider。导入 phase 为 verify → publish，不调用模型。查询 DTO 可把阶段映射为用户状态，不把 HTTP 协议细节暴露在普通创作流程里。

task_catalog、task_details 与 task_references 在同一事务建立：之后改提示词、模型设置、连线、节点名都不改变这次请求。节点名称不是供应商生成输入，落盘使用当前名称。凭据版本在所有需要恢复的任务结束前不得清理；不能只引用一个可能被覆盖 / 删除的“当前模型 API Key”。官方凭据 seam 不自动提供不可变版本，本插件需以不同记录 ID 管理各版本。

所有状态变化由 TaskService 统一提交：领取更新目录状态及详情租约；外部回执更新详情 ID / 原因及目录状态；成功把 task_outputs、详情成功信息、目录 succeeded / finished_at 一起提交。两表状态相关版本同时递增，读取详情时在同一读事务 JOIN，避免出现“目录成功、详情缺结果”。纯内部续租只更新详情版本。

### 4.4 `task_attempts`：步骤记录与外部提交标记

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| canvas_id / task_id / attempt_no | TEXT / INTEGER | PK(canvas_id,task_id,attempt_no)，同画布 task_catalog FK |
| operation | TEXT | submit / poll / download / publish |
| lease_token / runner_id | INTEGER / TEXT | 执行权凭证，配合任务 CAS |
| effect_key | TEXT / NULL | 供应商支持幂等时使用的固定提交键；同次逻辑提交不变 |
| issued_at | INTEGER / NULL | submit 第一个网络字节前提交的持久标记 |
| provider_receipt_json | TEXT / NULL | 有界步骤回执摘要，用于历史核对；当前输出恢复描述只归详情，不在每次 attempt 复制 |
| outcome / failure_source / error_code / error_message | TEXT / NULL | succeeded / definitive_failure / retryable / ambiguous；保留每次步骤成功 / 失败及脱敏原因 |
| started_at / finished_at | INTEGER / NULL | 步骤开始与结束 |

submit 执行顺序：创建 attempt 并提交 issued_at → 网络提交 → 同事务持久化详情回执 / external_task_id / 输出描述与目录状态 → 进入后续阶段。事务中不等待网络。详情保留最近失败，attempts 保留各次失败及恢复成功，不能恢复后就丢掉历史原因。

issued_at 表示“可能已经发出”，不是“供应商已接受”的证明。进程在标记后、发送前崩溃也按不明处理，这是防重复计费的保守选择。只有供应商协议明确支持幂等或按 effect_key 查回原请求时，才按该协议恢复；不因为某些 API 接受自定义请求头就宣称已有幂等保证。

轮询、下载、文件发布可以有多次步骤尝试。不能把 attempt_count、租约到期或 HTTP 超时作为允许重发生成请求的依据。默认外部生成提交不做盲目自动重试。

### 4.5 输入与输出引用

| 表 | 字段 | 主键 / 约束 |
| --- | --- | --- |
| `task_references` | canvas_id / task_id TEXT、reference_order INTEGER、asset_id TEXT、file_hash_snapshot TEXT | PK(canvas_id,task_id,reference_order)；同画布 task_catalog / asset FK；顺序固定；素材删除 RESTRICT |
| `task_outputs` | canvas_id / task_id TEXT、output_order INTEGER、asset_id TEXT | PK(canvas_id,task_id,output_order)；同画布 task_catalog / asset FK；UNIQUE(canvas_id,asset_id)，一份素材只有一个产生任务 |

task_references 是任务输入的唯一持久来源，不在 snapshot_json 再存一份可分叉的 referenceIds。提交时校验素材 ready、实际文件存在、类型可被模型接收；之后路径搬移只变定位，不变 asset_id / file_hash_snapshot。

获取输出描述后，在下载前一次性分配固定 asset_id，预登记 staging 素材和 task_outputs。同次结果保存重试始终使用同一组 ID / 顺序；只有 ready 素材对媒体接口和下游连接可见。import 同样以 output_order=0 记录导入结果。

```text
生成节点 N1，任务 T1 输出两份素材 A1 / A2
task_outputs(T1,0) → A1；task_outputs(T1,1) → A2
canvas_nodes[N1].selected_result_id = A2    当前预览
canvas_edges[E1].asset_id = A1             下游仍引用第一份
```

切换预览、再次生成不自动替换旧边；历史输出都保留。资源重新导入若沿用现有“替换其出边素材”行为，必须在一次内部图增量事务里修改节点及受影响边；历史 task_references 保持不变。

### 4.6 领取、并发、完成与恢复

| 环节 | 拟议机制 |
| --- | --- |
| 接受任务 | 检查已保存图修订、节点类型 / 输入、容量与凭据；事务写目录、详情、references 和幂等请求，成功后返回 202 + task_id |
| 唤醒 | 宿主启动扫描，加短周期到期扫描；计时器只是唤醒机制，SQLite 是队列事实来源 |
| 领取 | BEGIN IMMEDIATE 内从详情到期索引 JOIN 目录，CAS 目录状态 / 详情 lease_token；清本次 next_run_at，COMMIT 后才执行 IO |
| 同步供应商 | 后台持有请求直到得到结果；页面连接已经结束，所以刷新不打断该请求 |
| 异步供应商 | 在详情保存 external_task_id，然后按 next_run_at 查询；等待间隙释放本地执行租约 |
| 并发 | 模型未完成任务上限与 HTTP 同时调用上限分开；远端等待仍计入模型在途上限，不因释放轮询租约无限提交 |
| 文件 IO | 导入、下载和搬移另有有界并发与 staging 总容量上限；不让大量搬移挤占模型状态查询 |
| 完成 | 输出 ready、task_outputs 齐全后，事务写详情 success_at / summary，目录 succeeded / finished_at，清调度字段；无需等待页面打开 |
| 重试 | 可确认安全的查询 / 下载 / 发布使用有上限退避；达到上限进入 save_failed / needs_attention |
| 重启恢复 | 旧执行实例已退出后重领；queued 继续，已有 provider ID 继续查，已有输出继续保存，已 issued 无回执进入 needs_attention |

建议沿用当前“生成并发初值 2”作为设计起点，文件 IO 并发初值 2；正式上限需根据供应商额度、媒体体积和宿主负载验证。队列长度 / staging 配额达到上限时在接受前明确拒绝，不落入无法承担的无限队列。

一个 dataDir 只允许一个队列执行实例。用成熟的 OS 排他锁机制持有运行时锁，第二个 profile 指向同一 dataDir 时明确拒绝启动执行器；SQLite 单写事务不能代替整个进程生命周期的执行器锁。只有确认旧实例退出 / 完成停机，才释放并转移执行权。

lease 用于发现卡住的步骤及阻止旧结果发布，不用来证明外部请求没发生。每次领取生成新的 lease_token，旧执行器提交状态 / 文件指针必须被 CAS 拒绝。

持久时间字段使用 UTC epoch；运行中用单调时钟测请求耗时 / 心跳。启动把到期任务合并为每任务一次恢复，不重放漏掉的每轮 poll；轮询下次时间从本次完成重新计算。时钟前跳 / 后退时重新核对到期等待，避免长时间挂起；不能仅因 wall clock 变化抢占仍活着的实例。无 cron 日历窗口，时区 / 夏令时不改变 queue_seq；闰秒由 OS 时钟处理，不用于业务顺序。

每种阶段都有请求 / IO 超时和持久等待期限。submit 超时且接收结果不明进入 needs_attention；poll 超过等待期限暂停自动查询并保留供应商 ID，不伪造供应商失败；文件保存超时可按清单续做。监测最老排队年龄、逾期 next_run_at、无进展步骤、待保存结果及搬移失败，在宿主日志 / 状态接口记录；成功必须有 finished_at 与已保存输出证据，不能从“没报错”推断。

## 5. 文件改名、搬移与输出发布

### 5.1 持久操作与逐文件清单

| 表 | 字段 | 主键 / 约束 |
| --- | --- | --- |
| `file_operations` | canvas_id / id TEXT、kind TEXT、node_id / task_id TEXT NULL、status TEXT、expected_layout_revision INTEGER、expected_name_revision INTEGER NULL、manifest_cursor TEXT NULL、manifest_complete INTEGER、next_run_at INTEGER NULL、claimed_by TEXT NULL、lease_until INTEGER NULL、lease_token INTEGER、error_code TEXT NULL、created_at / updated_at / finished_at INTEGER NULL | PK(canvas_id,id)；kind=publish_outputs / rename_node / relocate_canvas；同画布 task_catalog FK；同画布最多一项 running 文件操作 |
| `file_operation_items` | canvas_id / operation_id TEXT、item_no INTEGER、asset_id TEXT、source_storage_id / source_filename TEXT NULL、source_staging_key TEXT NULL、target_storage_id / target_filename / target_name_key TEXT、expected_asset_version INTEGER、expected_file_hash TEXT NULL、state TEXT、bytes_copied INTEGER、error_code TEXT NULL、updated_at INTEGER | PK(canvas_id,operation_id,item_no)；同画布 operation / asset / source、target storage FK；活动目标路径部分唯一 |

operation status=queued / running / retry_wait / needs_attention / completed / superseded。item state=planned / copied / verified / committed / cleanup_done / failed / superseded。source 是已登记位置或受控 staging 二选一；发布输出时待下载 hash 可以暂未知，进入 verified 前必须有核验值。

操作 ID 由来源图 / 目录 mutation 或任务输出批次、目标版本派生稳定 ID；相同请求 / 同目标重试复用原操作，不再次建清单。版本已改变的后续操作使用新的 ID。

清单记录来源、目标、输出 ID、文件 hash 和每步进度。大画布分批建清单并保存 manifest_cursor；manifest_complete 后才能宣称范围扫描完成。任务新输出通过同画布发布协调器使用最新目录，无需等整个画布复制完。

目标路径冲突涉及现有素材和待执行清单两张表，单表 UNIQUE 不能代替跨表校验。宿主单写事务同时检查二者，并以不覆盖的文件创建落实；同一素材并发的改名 / 发布通过画布执行串行和版本条件协调。

### 5.2 逐文件提交协议

1. 数据库事务登记操作 / 清单及目标路径预留，保留当前可读指针。
2. 锁外复制到目标受控临时文件，或在同盘、文件不可变且平台支持时建立硬链接；原文件暂不删除。
3. 核验 bytes / file_hash、持久化文件及必要目录元信息，以不覆盖其他文件的方式落入最终名称。
4. 短事务核对当前 layout_revision、相关 name_revision、asset 版本及执行 token；通过才更新素材实际 storage_id / file_name / hash / version，标 item committed。
5. 新读请求使用已提交指针；旧读流仍可结束。确认没有受控引用 / 在途发布、且恢复清单不再需要后，延后清理这次操作的旧副本并标 cleanup_done。

复制 / fsync 与 SQLite **不是一个原子事务**。DB 提交前失败，旧指针仍可读；文件已落位但 DB 未提交时，按已持久清单核验并续做。DB 提交后旧副本清理失败只留下副本，不回滚到错误路径。普通上传来源原文件不在清理范围内。

若用户连续改名，旧操作在指针提交前发现版本过期就标 superseded，按最新目标重新排入范围；已经提交的文件仍可读，后续操作从实际指针继续搬。不能让旧操作在新名称提交后把路径改回去。根目录变化与节点改名并发也用两个版本共同验证。

文件发布的目标登记与指针事务在同画布协调器串行执行，复制不长期占用 SQLite 写锁。新生成结果按最新目标落盘；改名范围的末次对账核对是否还有未收敛素材，避免扫描时漏掉新输出。

只有已有登记清单且归属 / hash 一致的目标文件才可被恢复接纳，不能把用户目录中碰巧同名或同字节的外部文件直接认作插件文件。磁盘不可写、空间不足、外接盘离线时暂停相应文件操作，保留实际旧路径与生成结果描述。

### 5.3 文件、任务和图的修订边界

素材 / 任务进度更新本身不提高 graph_revision。但任务把新 asset_id 绑定到资源节点，或修改 selected_result_id，属于**节点持久内容变化**，必须记录内部 canvas_mutation、重算受影响 hash、提高 graph_revision；不能偷偷改节点又让客户端仍使用旧基线。

发布任务时读取当前节点行，保留用户期间改过的标题 / 坐标 / 参数；只更新本次输出需要的字段。生成结果默认预览更新要检查 binding_snapshot_json 中的选择条件，不能覆盖用户主动选中的历史结果；不符合时仍保存任务历史输出。资源重新导入修改出边时同步更新逻辑边 hash。

staging 素材的预登记、纯路径搬移或仅发布历史输出，不需要重写所有节点 / 边。若后台图增量与客户端草稿冲突，客户端拿到增量 / 新修订，保留草稿并按既定冲突流程处理，不静默覆盖。

## 6. 索引设计与对应查询

以下 SQL 仅说明索引，不在本次执行。正式 DDL 需同时建立上述主键、FK、CHECK；同一 UNIQUE 选择表约束或显式索引一种表达，不重复建等价索引。

```sql
-- 文件夹：同用户复合 FK 与名称唯一。
CREATE UNIQUE INDEX uq_folders_owner_id ON folders(owner_id, id);
CREATE UNIQUE INDEX uq_folders_owner_name ON folders(owner_id, name);
CREATE UNIQUE INDEX uq_canvases_owner_id ON canvases(owner_id, id);

-- SQLite UNIQUE 不把 NULL 当成相同值，根目录单独约束。
CREATE UNIQUE INDEX uq_canvases_folder_name
  ON canvases(owner_id, folder_id, name)
  WHERE folder_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_canvases_root_name
  ON canvases(owner_id, name)
  WHERE folder_id IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_canvases_owner_recent
  ON canvases(owner_id, updated_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX idx_canvases_folder_recent
  ON canvases(owner_id, folder_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_canvases_folder_refs ON canvases(owner_id, folder_id);

-- 单画布加载、边端点批量读取与引用查询。
CREATE INDEX idx_nodes_order ON canvas_nodes(canvas_id, sort_order, id);
CREATE INDEX idx_edges_order ON canvas_edges(canvas_id, sort_order, id);
CREATE INDEX idx_relations_node
  ON edge_node_relations(canvas_id, node_id, role, edge_id);
CREATE INDEX idx_nodes_asset ON canvas_nodes(canvas_id, asset_id)
  WHERE asset_id IS NOT NULL;
CREATE INDEX idx_nodes_preview ON canvas_nodes(canvas_id, selected_result_id)
  WHERE selected_result_id IS NOT NULL;
CREATE INDEX idx_edges_asset ON canvas_edges(canvas_id, asset_id, id);
CREATE UNIQUE INDEX uq_mutations_revision
  ON canvas_mutations(canvas_id, committed_revision) WHERE has_changes = 1;

-- 存储位置：保留旧目录预留，迁移期间也不能给别的画布占用。
CREATE UNIQUE INDEX uq_roots_owner_id ON storage_roots(owner_id, id);
CREATE UNIQUE INDEX uq_roots_path ON storage_roots(owner_id, path_key);
CREATE UNIQUE INDEX uq_storage_directory
  ON canvas_storage_locations(root_id, directory_key);
CREATE UNIQUE INDEX uq_asset_file
  ON canvas_assets(canvas_id, storage_id, file_name_key)
  WHERE storage_id IS NOT NULL;
CREATE INDEX idx_asset_name_source
  ON canvas_assets(canvas_id, name_source_node_id, id);

-- 上传：请求去重，当前节点的活动上传不能重复。
CREATE UNIQUE INDEX uq_upload_request ON upload_sessions(request_id);
CREATE UNIQUE INDEX uq_upload_active_node
  ON upload_sessions(canvas_id, node_id)
  WHERE status IN ('receiving', 'received', 'importing');

-- 任务目录只索引列表 / 状态；请求幂等与调度信息属于详情。
CREATE UNIQUE INDEX uq_task_request ON task_details(request_id);
CREATE UNIQUE INDEX uq_task_queue_seq ON task_catalog(queue_seq);
CREATE UNIQUE INDEX uq_task_active_node ON task_catalog(canvas_id, node_id)
  WHERE status IN ('queued', 'running', 'retry_wait',
                   'save_failed', 'needs_attention');
CREATE INDEX idx_task_due
  ON task_details(next_run_at, canvas_id, task_id)
  WHERE next_run_at IS NOT NULL;
CREATE INDEX idx_task_lease
  ON task_details(lease_until, canvas_id, task_id)
  WHERE claimed_by IS NOT NULL;
CREATE INDEX idx_task_external_id
  ON task_details(external_provider_key, external_task_id)
  WHERE external_task_id IS NOT NULL;
CREATE INDEX idx_task_provider_active
  ON task_details(external_provider_key, phase, canvas_id, task_id)
  WHERE phase IN ('submit', 'wait_provider');
CREATE INDEX idx_task_node_history
  ON task_catalog(canvas_id, node_id, queue_seq DESC);
CREATE INDEX idx_task_canvas_history
  ON task_catalog(canvas_id, queue_seq DESC);
CREATE INDEX idx_task_attention
  ON task_catalog(status, updated_at, canvas_id, id)
  WHERE status IN ('save_failed', 'needs_attention');
CREATE INDEX idx_task_reference_asset
  ON task_references(canvas_id, asset_id, task_id);
CREATE UNIQUE INDEX uq_task_output_asset
  ON task_outputs(canvas_id, asset_id);

-- 文件操作：到期执行、同画布执行互斥、素材恢复与目标预留。
CREATE INDEX idx_file_operation_due
  ON file_operations(next_run_at, canvas_id, id)
  WHERE status IN ('queued', 'retry_wait');
CREATE UNIQUE INDEX uq_file_operation_running
  ON file_operations(canvas_id) WHERE status = 'running';
CREATE INDEX idx_file_item_asset
  ON file_operation_items(canvas_id, asset_id, operation_id);
CREATE UNIQUE INDEX uq_file_item_target
  ON file_operation_items(canvas_id, target_storage_id, target_name_key)
  WHERE state IN ('planned', 'copied', 'verified', 'failed');
CREATE INDEX idx_file_item_source
  ON file_operation_items(canvas_id, source_storage_id, source_filename)
  WHERE source_storage_id IS NOT NULL;
```

| 查询 / 操作 | 索引与事务路径 |
| --- | --- |
| 用户画布 / 文件夹内画布列表 | owner_recent / folder_recent；列表不读取整张图或大媒体 |
| 删除文件夹前查所有引用 | folder_refs，包括逻辑删除画布 |
| 打开画布 | nodes / edges 按 canvas_id、sort_order 批量取；端点一次批量 JOIN |
| 查节点出入边 / 删除节点 | relations_node，再 JOIN edge 主键；避免每条边一次查询 |
| 仅拖动节点 | 节点主键定位、旧 hash 校验；不用按 content_hash 扫表 |
| 增量刷新 | uq_mutations_revision 的 canvas_id + revision 范围 |
| 播放媒体 | asset 主键 → storage 复合主键 → root 主键，认证接口返回流 / Range |
| 节点改名 | asset_name_source 找其拥有的文件，预留目标、创建搬移记录 |
| 查实际路径 / 待搬移路径冲突 | uq_asset_file + uq_file_item_target；跨表单写事务检查 |
| 领取任务 | 详情 task_due 取到期候选 JOIN 目录，再核对状态 / 容量；两表 CAS 领取 |
| 节点最新任务 / 画布任务表 | node_history / canvas_history，按 queue_seq 排序 |
| 点击任务查看详情 | 目录主键 JOIN 详情复合主键，在同一读事务取成功 / 失败与输出 |
| 按外部任务 ID 找本地任务 | task_external_id；必须带外部提供方键，再核对 canvas owner |
| 恢复卡住的执行步骤 / 核对在途额度 | task_lease / provider_active JOIN 目录；不把 queued 或终态误计为在途 |
| 恢复原任务步骤 | task_attempts 主键按 task_id 读取，可倒序扫描；不另建等价索引 |
| 查任务引用 / 输出顺序 | references / outputs 各自主键 |
| 查某素材历史输出归属 | uq_task_output_asset，不再重复建同前缀普通索引 |
| 分页搬移 / 断点恢复 | item 主键的 operation_id + item_no；manifest_cursor / state 决定续做 |

hash 用于主键定位后的比较，不是主键，也不默认建立 hash 索引。没有文件去重查询，file_hash 不建索引。目录列表只读 task_catalog；执行器通过详情轻量标量列取候选，领取后才读取 snapshot_json，不先对大 JSON 盲目建索引。

到期候选按 next_run_at 优先，同阶段排队按 queue_seq；分表后的 JOIN / 排序可能使用临时排序，必须验证实际计划与有界候选量，不能宣称一个详情索引同时覆盖目录顺序。目录分页使用 queue_seq 游标，不随着列表变长做大 OFFSET。

正式实施需用 EXPLAIN QUERY PLAN 验证列表、关系 JOIN、到期领取和目标冲突查询；统计索引写放大。partial 索引条件必须与查询状态条件一致，不能只列名字就声称查询一定命中。

## 7. 增量存储、hash 与事务

### 7.1 hash 的范围

`content_hash = SHA256(canonical({domain, owner_id / canvas_id, entity_id, persistent_content}))`，64 个十六进制字符，256 bit。canonical 固定字段 / 对象键序、UTF-8、null 规则、有限数字和 -0 归一，保留有意义数组顺序及提示词内容；不含自己、时间、版本和临时选择态。

节点 hash 包含标题、类型、坐标、模型 / 参数、素材选择和呈现顺序。逻辑边 hash 包含 asset_id、顺序及 source / target 的 node_id、port_key；关系行另算自己的 hash。节点移动不会重算所有相连边，因为端点引用的是节点 ID。

画布 content_hash 只覆盖业务元信息，不塞入全图；目标目录由 layout_revision / 存储位置记录管理。commit_hash 是实际变化摘要与 prev_commit_hash 串联的提交链，**不是当前全图内容 hash**。只有导出 / 离线核验才对完整节点与边清单排序核对。

snapshot_hash 校验不可变任务输入，file_hash 校验文件字节。宿主重算客户端传来的内容 hash；摘要不能替代类型、权限、FK、业务约束或修订校验。

### 7.2 图增量写入

1. 前端只记录 dirty 节点、边、视口和删除 ID；拖动合并最终坐标，提示词 debounce；只计算这些对象的新 hash。
2. 与最后确认 hash 相同的对象不发；新增后未保存就删除可以抵消。请求包含 canvas_id、mutation_id、base_revision、operations 和对象 expected_hash / new_hash。
3. 宿主单写队列 BEGIN IMMEDIATE，先查 receipt：同 ID / 同请求返回原 ACK，不重新写；同 ID / 不同请求拒绝。
4. 无 receipt 时校验图修订、旧对象 hash、用户归属、未删除、素材 / 任务锁及事务后的图约束。
5. 新增按节点 → 边 → 关系；删除按边 / 关系 → 节点。只更新受影响行，任一错误整批回滚。
6. 有实际变化 graph_revision +1，写 changes_json 与提交链 / receipt；no-op 不递增图修订，仍可有请求回执。
7. COMMIT 成功后 ACK；前端只清除发送快照的 dirty，在途产生的新编辑继续保留。

上传自动建节点、结果绑定和资源重新导入也是内部图增量，使用稳定 mutation_id、当前数据库修订与同样的事务校验。不使用前端过期的完整图覆盖后台新输出。

文件夹 / 画布元信息 CRUD 用 meta_revision / expected_hash 及 catalog_mutations。画布改名和改媒体根目录在目录事务里一并登记目标位置与 file_operation；不会重写所有节点。节点改名既更新节点 hash / 图修订，也在同事务登记文件操作，避免“名字变了但搬移请求丢了”。

初期并发策略为应用层显式处理冲突：旧版本写入返回 409，保留草稿、读取最新内容后处理，不使用时间戳最后写入覆盖，也不自动做 CRDT 合并。读请求走同一个本地宿主 SQLite，在一致读事务返回固定 snapshot_revision，满足提交后的 read-your-writes。

图回执 / 增量日志清理与 min_replay_revision 推进同一事务；低于水位的保存 / 增量读要求重新载入。no-op 可与其他回执共享 committed_revision，因此只有 has_changes=1 才建 revision UNIQUE。目录回执初期不清理；以后要清理，须先设计目录请求 epoch / 过期协议，不能删除回执后把旧请求重新执行。

增量写入不代表全部验证都是 O(变化数)：新增边的成环校验最坏仍可能遍历整张图；单张大图是主要热点，后续可评估图验证优化，当前不拆库 / 分片。

### 7.3 各操作的一致性与故障结果

| 数据 / 操作 | 一致性、冲突与幂等 | 故障时用户看见什么 |
| --- | --- | --- |
| 目录、名称、用户设置 | 本地 SQLite 原子事务；版本校验；目录回执幂等 | 提交失败保持原记录；没有自动 failover |
| 节点、边、两条端点与视口 | 同画布一次事务；graph_revision + 旧 hash；图回执幂等 | 整批成功或回滚，草稿保留 |
| 任务接受 / 快照 | task_catalog、task_details、references 和请求 ID 同事务，202 在 COMMIT 后 | ACK 丢失可以查回原任务，不重复入队 |
| 供应商外部效果 | 本地 issued 标记与外部请求不原子；按能力查回原请求 | 已 issued 无回执显示待处理，不自动重新计费 |
| 文件发布 / 搬移 | 文件先核验，指针 CAS 提交；持久清单恢复 | 改名期间可读旧文件；失败显示未搬完 |
| 任务进度读取 | 返回已提交状态；页面通知 / 轮询可能暂时落后 | 刷新读回数据库，不把 UI 失联当任务失败 |
| 媒体读取 | 按已提交实际指针、鉴权与 Range | 文件外部删除 / 损坏明确不可用，不换成其他文件 |

业务目录 / 图是数据库权威；媒体字节和 issued / 回执 / 操作清单共同决定恢复，不能只靠一份 UI 图推断文件是否安全可删除。API Key 仅供宿主读取，SQL / 日志 / 公开 DTO 不泄露凭据。

SQLite 采用本机单库、WAL、foreign_keys=ON、synchronous=FULL 与短事务；事务内不下载、复制或调用供应商。目标采用 node:sqlite 和宿主内 Worker，拟议最低 Node 版本 22.13，细节见目标架构；busy_timeout、批次上限与性能需要验证。磁盘 / 写锁失败明确返回错误，没有副本、跨机 failover 或承诺任意硬件故障零丢失。本次不修改当前 package.json 的运行版本要求。

## 8. DeepSeek Harness 的插件存活边界

核对依据包括用户提供的[官方参考](https://deepseek-harness.github.io/deepseek-harness/reference/)、[插件入门](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)、[快速开始](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)，当前安装的 `0.2.1-rc.2` SDK 与插件源码。2026-10-26 核对的官方源仓库 master 为 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`；在线文档随版本演进，不能把未安装的扩展服务当作当前必备依赖。

| 行为 | 宿主执行器 | 任务结果 |
| --- | --- | --- |
| 切到会话、关画布面板、刷新 / 关浏览器 | Harness 与插件宿主仍运行 | 已接受任务继续；未传完的上传可能中断 |
| 禁用 / 卸载实际承载执行器的插件 | owning fiber dispose，会调用清理 | 本地执行停止；重启后按数据库状态恢复 |
| 停止 Harness 进程 | 进程内代码不再执行 | 本地请求 / 下载 / 保存不能继续；已提交远端任务可能仍由供应商运行 |
| 宿主电脑关机 | 本地运行停止 | 下一次启动恢复；远端能否继续取决于供应商 |
| 仅关闭独立 UI 扩展，后台服务仍启用 | 如果未来把二者部署为独立生命周期 | 后台可以继续；不能把禁用后台服务也解释成只是关 UI |

证据：

- [官方布局包说明](../../node_modules/@deepseek-ai/dsh-client-ui-layout/README.md)：Global panel 是 main 注册槽；selectPanel 改变选中面板，不是卸载宿主插件。
- [Cordis fiber 源码](../../node_modules/@deepseek-ai/cordis/src/fiber.ts)：Disposable 说明约在 69–80 行，dispose 约在 195–196 行，_unload 约在 675 行；卸载会执行已注册清理。
- [本插件宿主入口](../../src/host/index.ts)：service.init 后注册 `ctx.effect(() => () => service.close())`。
- [本插件 close](../../src/host/service.ts)：约 283–287 行，清除计时器、abort、等待 active 并关闭存储。

上述 node_modules 链接是完整源码工作区中的版本证据；安装包不包含这些依赖源码。宿主升级时必须重新核对，不能把当前版本的面板行为推定为所有未来版本保证。

官方 [jobs-local 说明](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/jobs/jobs-local/README.zh.md) 明确其为内存注册表、达到容量时拒绝而非排队，进程退出后不恢复执行 / 输出环。因此不将它替代本插件 SQLite 队列；当前本地 SDK 未安装 jobs 包，不把 ctx.jobs 写成无条件可用。未来宿主任务面板接入只能增加受版本验证的适配层，不能另起第二个执行者。

推荐页面组件与后台执行模块分开：页面只走提交 / 查询接口；执行器在宿主侧初始化，不跟着 React useEffect 或面板卸载停止。本稿默认只保证**宿主和后台运行时保持启用时**的独立执行。

官方 connection 层会在客户端断开时取消请求处理信号。提交事务 COMMIT 后任务转交 Runtime 自己的信号 / 所有权，不继承 HTTP request 或 Peer 的销毁；未完成上传接收仍可跟随请求取消。不能仅把执行函数写在宿主 handler 里就保证独立于浏览器。

Harness 不会自动把插件变成永久守护进程。如果要求“禁用整个插件 / 退出 Harness 后，本地任务也继续”，必须让执行器运行在独立后台服务中，由该服务独占 SQLite / 媒体写入，Harness 插件只作为客户端；启动、停机、凭据和升级也由该服务负责。这是额外部署形态，本稿说明边界，不把它冒充现有能力。

## 9. 兼容、核验与后续实施条件

### 9.1 旧数据迁移

`migration_imports`：source_key TEXT 主键、canvas_id TEXT、source_hash TEXT、checkpoint_json TEXT、status TEXT、created_at / verified_at INTEGER；记录每份旧 workspace JSON 到新普通画布的映射，不把 workspace 变成业务文件夹。

保留旧 node / edge / task / asset ID、数组顺序、模型协议与结果引用。旧 JSON 和原媒体保持不变；在独立 staging SQLite 中导入、核验。先登记原文件实际位置，需要名称布局时复制到新目录，不能为实现命名要求就提前搬走旧文件。

旧任务同事务映射到 task_catalog(kind=generate) + task_details：旧 providerTaskId 写入详情 external_task_id，继续原查询；已有私有输出描述转换为固定 outputs；issued 无结果映射 needs_attention；旧 abandoned 保留为结束本地等待，不能伪造成 canceled。迁移期间不启动供应商新提交。旧 credentials.json 仅作为迁移输入，版本凭据写入 Harness 提供方后核验，旧文件不改。停止旧写者、核验后才切换单写者，不做双写。

有 SQLite 新写后不能直接回到陈旧 JSON；须修复新库或反向导出核验。保留旧副本不是可无损直接回滚的承诺。

### 9.2 数据核验与修复责任

宿主启动先做任务 / 上传 / 文件操作恢复；维护者负责异常修复。定期有界核对路径存在性、staging / 目标清单归属、未完成搬移和卡住的队列，避免每次启动读遍所有视频字节；完整 hash 核验用于写入、迁移、恢复和明确的深度检查。

核验不变量包括：每边两角色、没有跨画布引用、ready 文件可定位、输出 ID / 次序不重复、每节点最多一个未结束任务、外部 issued 有可解释结果、路径目标与当前名称版本最终收敛。SQLite 引用 + 持久文件清单为判断依据，不从目录名字或“当前预览没显示”推断应删除。

本期不新增媒体自动 GC；删除节点 / 画布不立即删历史素材和任务。第 5 节清理仅处理一次已提交搬移产生的受控旧副本，不等同于删除业务媒体。

备份包括一致 SQLite 快照、各存储根中的实际媒体、受限凭据和 staging / 未结束操作；运行中不能只复制主 db 而漏掉 WAL。恢复前先停止写者，再核对实际路径；若根目录改变，应更新登记 / 搬移记录，而不是覆盖历史引用。

### 9.3 方案取舍与待验证项

| 方案 | 处理 |
| --- | --- |
| SQLite 元信息 + 按名称组织媒体 + 持久后台队列 | 推荐；满足增量和多画布、名称布局、刷新恢复；增加路径搬移和任务恢复成本 |
| 原先 UUID 扁平媒体目录 | 不采用为新目标布局；旧数据可登记保留后迁移 |
| 整张画布 JSON 每次重写 | 不采用；无法实现节点 / 边独立增量事务 |
| 浏览器队列直接等待模型 HTTP | 不采用；页面刷新会切断执行生命周期 |
| 全部媒体做 SQLite BLOB | 不采用；大媒体播放、备份与写放大不适合本场景 |
| 独立守护进程 | 仅在需要跨 Harness 停机持续执行时采用；另有部署 / 运维成本 |

实施前必须验证：所用 SQLite 驱动与支持的 Node 版本、宿主线程阻塞、排他锁实现、目标平台大小写 / 符号链接 / 不覆盖落盘行为、跨盘复制与空间不足、驱动 FK / partial 索引支持、供应商是否真正提供请求幂等 / 恢复查询。

人工 / 自动验收重点：

1. 添加菜单没有空资源节点；上传 / 拖拽图片、视频、音频自动生成对应节点，多文件不互相回滚。
2. 只改一个节点 / 视口只写受影响行；边与两端同事务；no-op、重复 ACK、后台图增量不丢编辑。
3. 文件夹 / 画布 / 节点重命名、同名冲突、连续改名、根目录跨盘变化，素材 ID 与连线引用不变。
4. 复制完成但 DB 未提交、DB 已提交但旧文件未清理、外接盘离线、目标被外部文件占用时均可解释和恢复。
5. 刷新 / 关面板不打断已接受同步图片和异步视频任务；未传完上传明确中断；重启不盲目重提 issued 请求。
6. 保存原结果重试不产生新 asset_id；凭据旋转 / 删除、供应商 URL 过期、进度查询失败都不伪造完成。
7. 第二执行实例被拒绝；旧 lease_token 不能发布；等待远端任务仍计入在途额度。
8. 旧数据导入前后节点、边、素材、任务、顺序和文件 hash 核验一致；旧源文件不变。
9. 任务目录不含大 JSON / 失败详情；目录 / 详情一起创建和结算；外部 ID 持久化后刷新可继续查询，供应商失败原因与本地保存失败可分别查看。

上文为原设计基线；本次实施和验证结果维护在[验证记录](../verification.md)，安装包信息见[运行指南](../operations.md)。
