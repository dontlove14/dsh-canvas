# SQLite 多画布与文件夹存储设计 v0.1

状态：历史草案，已由 [v0.2](sqlite-canvas-storage-v0.2.md) 取代；未实施。

文档类型：解释 / 设计参考；负责人：项目维护者；最近核对：2026-10-26。
评审、实施或需求改变时复核。本草案不替代[现行数据契约](../data-api.md)或[已采纳存储 ADR](../adr/0003-local-single-writer-store.md)。

本版保留原稿供追溯。媒体布局、上传建节点、重命名和后台任务均以 v0.2 草案为准；下文的 UUID 扁平媒体目录及任务配套方案已被替代。

## 1. 业务形态

用户可以创建很多张画布；**每张画布就是一个项目**，不再单设一个“项目”对象。多个画布可以放进一个文件夹，文件夹和画布都可以重命名。

```text
用户的画布列表
  ├─ 文件夹 1
  │   ├─ 画布 1（项目）
  │   └─ 画布 2（项目）
  ├─ 文件夹 2
  │   └─ 画布 3（项目）
  └─ 画布 4（项目，未放入文件夹）
```

画布没有“图片项目 / 视频项目 / 海报项目”等类型。图片、视频、音频等类型只属于画布内部的节点。Harness 工作区不作为画布列表的业务分组，也不限制一个用户能创建多少张画布；旧 workspace_id 只在迁移映射里保留。

本草案按一层文件夹设计。每张画布最多属于一个文件夹，folder_id 为 NULL 时在根目录。文件夹是数据库中的分类，不对应磁盘目录；移动画布只改 folder_id，节点和媒体路径不变。

| 操作 | 业务规则 |
| --- | --- |
| 创建画布 | 填名称，可选文件夹；创建空画布和默认视口 |
| 打开画布 | 只载入这一张画布，其他画布不跟着加载 |
| 画布重命名 | 只修改画布名称和元信息版本，不重写节点 / 边 |
| 移动画布 | 修改 folder_id，允许移回根目录；所属用户不变 |
| 创建 / 重命名文件夹 | 只修改文件夹记录，内部画布名称与内容不变 |
| 切换画布 | 等待当前草稿保存；失败或冲突时保留草稿 |
| 删除画布 | 确认后逻辑删除，隐藏列表入口；有未结束任务时拒绝；媒体和历史暂保留 |
| 删除文件夹 | 初期只允许删除空文件夹，非空先移动画布；仅剩逻辑删除画布时先把它们移回根目录再删除文件夹 |

同一用户的文件夹名唯一；同一文件夹内画布名唯一；根目录画布名也唯一。不同文件夹可有同名画布。名称 trim 后非空，建议上限 160 字符，比较采用 BINARY。文件夹和画布可同名，因为两者是不同对象。

数据库以 owner_id 表达用户归属。当前 Harness 插件只有认证 owner，不新增账户系统：owner_id 由宿主身份适配层提供，本机单用户场景用数据目录内稳定的 owner 标识。浏览器不能自行传 owner_id 选择他人数据。若以后多用户，需要接入宿主稳定用户 ID 和对应权限；不把当前实现当成已有多租户能力。

## 2. 核心表与关系

推荐一个 dataDir 一个 `canvas.sqlite`，同一库保存该用户的多张画布。媒体继续放在 `media/`。插件宿主直接管理 SQLite 短事务，满足跨表一起提交；不依赖官方 KV 接口完成跨表事务。

核心业务表是：

```text
folders ──< canvases ──< canvas_nodes
                    └─< canvas_edges

canvas_edges ──< edge_node_relations >── canvas_nodes
```

`canvases` 同时代表画布和项目，没有独立 projects 表。`canvas_edges` 存边自身数据，`edge_node_relations` 是 source / target 的唯一存储位置，边表不重复保存端点。

### 2.1 `folders`：文件夹

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT | UUID，主键 |
| owner_id | TEXT | 所属用户 |
| name | TEXT | 文件夹名称 |
| meta_revision | INTEGER | 重命名等元信息更新版本 |
| content_hash | TEXT | 名称及用户归属的内容摘要 |
| created_at / updated_at | INTEGER | 毫秒时间戳 |

约束：UNIQUE(owner_id, id)，供同用户复合外键引用；UNIQUE(owner_id, name)，防止同用户文件夹重名。当前一层文件夹，不设置 parent_id。

### 2.2 `canvases`：画布，也就是项目

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT | UUID，主键；画布身份，不随重命名改变 |
| owner_id | TEXT | 所属用户 |
| folder_id | TEXT / NULL | 所属文件夹，NULL 为根目录 |
| name | TEXT | 画布名称 |
| meta_revision | INTEGER | 名称、文件夹归属、删除状态更新版本 |
| graph_revision | INTEGER | 节点 / 边 / 视口的一批实际修改，提交后递增一次 |
| content_hash | TEXT | 画布元信息摘要，不把整个 nodes / edges 塞进来 |
| commit_hash | TEXT | 图增量提交链摘要 |
| min_replay_revision | INTEGER | 增量 / 幂等记录清理后的最低有效基线，初值 0 |
| created_at / updated_at | INTEGER | 毫秒时间戳 |
| deleted_at | INTEGER / NULL | 逻辑删除，活动列表过滤 NULL |

外键 `(owner_id, folder_id)` → `folders(owner_id, id)`，ON DELETE RESTRICT，防止画布放进别人的文件夹。

画布名用两条部分唯一索引：一条限制 folder_id 非 NULL 的同文件夹活动画布，一条单独限制根目录活动画布。SQLite 的 UNIQUE 对 NULL 不自动去重，不能只建一条索引。

画布重命名、移动或逻辑删除只更新本行的元信息 hash / meta_revision，不改变 graph_revision。被逻辑删除的画布移动到根目录时不参与活动名称唯一约束。

### 2.3 `canvas_nodes`：节点

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| canvas_id / id | TEXT | PK(canvas_id, id)，允许保留旧数据里的节点 ID |
| kind | TEXT | 现有五类节点枚举 |
| title | TEXT | 节点名称 |
| position_x / position_y | REAL | 有限坐标 |
| model_id | TEXT / NULL | 模型 ID |
| prompt | TEXT | 提示词 |
| params_json | TEXT / NULL | 小型生成参数，JSON 校验；不是整张画布 |
| asset_id | TEXT / NULL | 资源节点当前素材 |
| selected_result_id | TEXT / NULL | 当前预览的生成结果 |
| sort_order | INTEGER | 保留 nodes 顺序 / 呈现层级 |
| row_version | INTEGER | 本节点存储版本 |
| content_hash | TEXT | 节点持久内容 SHA-256 |
| created_at / updated_at | INTEGER | 时间戳 |

canvas_id 外键指向 canvases。节点不存入边 / 出边数组；移动一个节点，只更新该节点的坐标、hash、版本、时间和画布保存元信息。

素材字段使用同画布复合外键到 canvas_assets。模型目前仍由全局文件管理，不设置指向不存在模型表的外键；合法模型与素材类型在宿主校验。

### 2.4 `canvas_edges`：边

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| canvas_id / id | TEXT | PK(canvas_id, id) |
| asset_id | TEXT | 本边绑定的具体素材 |
| sort_order | INTEGER | 保留 edges / 下游参考输入顺序 |
| row_version | INTEGER | 本逻辑边存储版本 |
| content_hash | TEXT | 边属性及两端关系共同计算的 SHA-256 |
| created_at / updated_at | INTEGER | 时间戳 |

canvas_id 外键指向 canvases；asset_id 使用同画布复合外键到 canvas_assets。source / target 不在此表重复存储。

### 2.5 `edge_node_relations`：边与节点的关系

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| canvas_id | TEXT | 画布归属，阻止跨画布连线 |
| edge_id | TEXT | 对应边 |
| role | TEXT | CHECK(source / target) |
| node_id | TEXT | 对应节点 |
| port_key | TEXT | 当前为 output / input，记录端点连接位置 |
| content_hash | TEXT | 本条端点关系摘要 |

主键 `(canvas_id, edge_id, role)`，一条边恰好两行：

| canvas_id | edge_id | role | node_id | port_key |
| --- | --- | --- | --- | --- |
| C1 | E1 | source | N1 | output |
| C1 | E1 | target | N2 | input |

复合外键：

- `(canvas_id, edge_id)` → `canvas_edges(canvas_id, id)`，边删除 CASCADE 关系。
- `(canvas_id, node_id)` → `canvas_nodes(canvas_id, id)`，ON DELETE RESTRICT，先删除相关边再删节点。

主键和 role CHECK 保证每角色最多一行；“必须同时有 source 和 target”是跨行约束，由宿主在事务提交前验证，不能声称单靠 FK 保证。边和两条关系同一事务落库，任何失败整批回滚。

同目标不能重复引用同一素材涉及关系表和边表 JOIN，在唯一宿主写事务内校验；无环、目标为生成节点、来源素材归属也属于业务校验。不能用一条普通单表 UNIQUE 代替这些约束。

### 2.6 保存状态与请求记录

| 表 | 主要字段 | 用途 |
| --- | --- | --- |
| `canvas_state` | canvas_id PK、viewport_x / y / zoom、row_version、content_hash、updated_at | 每画布一行视口状态；平移缩放不更新所有节点 |
| `canvas_mutations` | canvas_id、mutation_id、request_hash、base_revision、committed_revision、has_changes、prev_commit_hash、commit_hash、changes_json、created_at | 保存幂等、图增量读取、受影响对象 ID / before / after hash 和删除 ID |

canvas_mutations 主键 `(canvas_id, mutation_id)`；实际变更可加 UNIQUE(canvas_id, committed_revision) WHERE has_changes=1。no-op 不递增图修订，可保留 receipt，因此不能对所有记录直接使用 revision 唯一。

## 3. 索引设计

下列 SQL 是**设计示意，不在本次执行**。主键、唯一规则和复合外键在正式 DDL 中配套建立；同一唯一规则选择表内 UNIQUE 或显式索引一种表达，不重复建等价索引。名称列需采用前述一致的比较规则。

```sql
-- 文件夹归属复合键及同用户名称唯一。
CREATE UNIQUE INDEX uq_folders_owner_id
  ON folders(owner_id, id);
CREATE UNIQUE INDEX uq_folders_owner_name
  ON folders(owner_id, name);

-- 文件夹内画布名称唯一；排除逻辑删除的画布。
CREATE UNIQUE INDEX uq_canvases_folder_name
  ON canvases(owner_id, folder_id, name)
  WHERE folder_id IS NOT NULL AND deleted_at IS NULL;

-- 根目录画布名称唯一：单独处理 NULL。
CREATE UNIQUE INDEX uq_canvases_root_name
  ON canvases(owner_id, name)
  WHERE folder_id IS NULL AND deleted_at IS NULL;

-- 用户全部活动画布，及指定文件夹的活动画布。
CREATE INDEX idx_canvases_owner_recent
  ON canvases(owner_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_canvases_folder_recent
  ON canvases(owner_id, folder_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;

-- 文件夹物理删除前查全部引用，包括逻辑删除画布。
CREATE INDEX idx_canvases_folder_refs
  ON canvases(owner_id, folder_id);

-- 打开一张画布并保留呈现 / 输入顺序。
CREATE INDEX idx_nodes_canvas_order
  ON canvas_nodes(canvas_id, sort_order, id);
CREATE INDEX idx_edges_canvas_order
  ON canvas_edges(canvas_id, sort_order, id);

-- 查某节点入边、出边及删除时的全部关联边。
CREATE INDEX idx_relations_node
  ON edge_node_relations(canvas_id, node_id, role, edge_id);

-- 查边所引用的素材。
CREATE INDEX idx_edges_asset
  ON canvas_edges(canvas_id, asset_id, id);

-- 根据修订读取实际图变更。
CREATE INDEX idx_mutations_revision
  ON canvas_mutations(canvas_id, committed_revision)
  WHERE has_changes = 1;
```

`uq_folders_owner_name` 同时用于文件夹按名称列表与查重，不再为这条查询建立等价索引。实施时用 EXPLAIN QUERY PLAN 确认实际计划。

主键已经覆盖“按节点 / 边 ID 读取”和“按 edge_id 找最多两条端点关系”，不再建同样的重复索引。不把 content_hash 当主键，也不为每个字段建索引；hash 通常在 UUID 定位到行后比较。

| 常见查询 | 使用路径 |
| --- | --- |
| 用户全部画布 | owner_id + deleted_at IS NULL，recent 索引 |
| 文件夹里的画布 | owner_id + folder_id + 活动过滤，folder_recent |
| 根目录画布 | owner_id + folder_id IS NULL，同一列表索引 |
| 画布重命名查重 | 对应部分唯一索引 |
| 打开画布 | nodes / edges 按 canvas_id 及 sort_order 批量取，关系表一次批量 JOIN |
| 查节点输入 / 输出 | idx_relations_node，再 JOIN edge 主键 |
| 删除节点 | 同上，找所有关联边，一起删除 |
| 素材重复输入检查 | target 关系定位 + JOIN edge.asset_id；本批新增也一起校验 |
| 增量刷新 | canvas_id + after_revision，读事务内固定 snapshot_revision |

避免每条边单独查询端点的 N+1 查询；画布列表不读取所有节点、任务私有数据或媒体字节。

## 4. 增量存储流程与 hash

### 4.1 只处理实际变化

前端维护 dirty 节点 / 边 / 视口集合及最后确认内容：

1. 记录新增、修改、删除 ID，拖动只保留最终坐标，提示词按 debounce 合并。
2. 只对 dirty 对象计算新内容 hash；与已确认内容一致时取消这项变更。
3. 请求只带变化集合，不上传整张图；新建后未保存就删除可以抵消。
4. 宿主只 INSERT / UPDATE / DELETE 受影响行，关联修改同一事务。
5. 请求在途时的新编辑继续保留，ACK 只确认发送快照，不误清后续 dirty。

### 4.2 hash 的精确定义

`content_hash = SHA256(canonical({domain, canvas_id / owner_id, entity_id, persistent_content}))`，输出 64 个十六进制字符（256 bit）。

canonical 固定字段和对象键顺序、UTF-8、null 规则、有限数值、-0 归一；保留有意义数组顺序和提示词内容。hash 不含自己、时间戳、版本或临时选择状态。画布元信息包含名称、folder_id、owner_id 和 deleted 布尔值；节点包含全部持久字段。

逻辑边 hash 包含 edge 属性、asset_id、sort_order 及 source / target 的 node_id / port_key；关系行另算自己的 hash。节点移动不把所有关联边重算，因为边引用节点 ID，不内嵌节点坐标。

宿主重算并校验客户端 hash；hash 只判断内容 / 完整性，不代替 Schema、权限、FK、业务规则或并发修订。媒体字节另算 file_hash，流写时计算，不与节点 JSON 摘要混为一谈。

### 4.3 一批保存的事务

请求：`canvas_id + mutation_id + base_revision + operations`。修改 / 删除带 expected_hash，新对象带 new_hash；request_hash 覆盖规范化请求内容。网络重试保持 mutation_id 和请求内容不变。

1. 入单写队列，BEGIN IMMEDIATE。
2. 查询 canvas_mutations：相同 ID / 相同请求返回原 ACK，不再次写；同 ID 不同请求拒绝。
3. 无 receipt 且旧基线低于 min_replay_revision 返回历史过期；否则校验画布归属、未删除、base_revision、对象旧 hash。
4. 合并出事务后的对象，重新算 hash，并校验端点、素材、重复输入、无环、删除任务锁。
5. 只写实际变化。新增顺序为节点 → 边 → 关系；删除顺序为关系 / 边 → 节点。资源重新导入引起的出边素材变更一起提交。
6. 有实际图 / 视口变化，graph_revision +1，记录批次摘要 / receipt；无实体变化不提高修订。
7. COMMIT 成功后 ACK 并更新内存；失败整批 ROLLBACK，草稿保留。

元信息 CRUD 使用自己的 meta_revision / expected_hash：画布与文件夹改名不进入图保存批次。创建使用预分配 UUID；已存在 ID 不覆盖，删除重试不新建。若要为元信息 API 提供与图保存相同的完整请求幂等语义，应单设 catalog_mutations，不混入 graph_revision；本期图保存的 receipt 不冒充管理所有目录操作。

保留“画布修订号 + 旧对象 hash”双校验，防止旧窗口覆盖；初期冲突保留草稿、导出和重新载入，不自动合并。

项目级 commit_hash 是实际变更集合串联 prev_commit_hash 的提交摘要，**不是当前全图内容 hash**。每次保存不重算整图；导出 / 离线核验才按稳定排序重新核对完整节点 / 边清单。增量读在一致读事务里返回受影响对象的最新状态及删除 ID，不是撤销 / 全历史回放功能。

清理日志及推进 min_replay_revision 同一事务；watermark 不高于 graph_revision，当前基线的 no-op receipt 不单独按时间清掉。窗口外原请求和增量读明确要求重新载入，客户端为新变更使用新请求 ID。窗口长度待容量测量，不宣称无限幂等日志。

新增边成环校验最坏仍可能 O(N+E)，增量写入不保证所有业务验证恒为 O(变化数)。

## 5. 现有素材、任务与兼容

### 5.1 媒体文件保存位置

图片、视频、音频统一采用“磁盘保存文件字节，SQLite 保存素材元信息和引用”的方式。导入文件复制到插件存储；生成结果及时下载到本机，不仅保存供应商临时 URL。

```text
dataDir/
  canvas.sqlite
  media/
    <file UUID>          一份图片文件
    <file UUID>          一份视频文件
    <file UUID>          一份音频文件
```

所有文件共用 media 目录，文件名使用稳定 UUID，不使用文件夹名、画布名、节点名或用户原文件名。因此重命名文件夹 / 画布或移动画布不需要移动文件。实际 MIME 和原显示文件名放在素材表，磁盘文件可以不带扩展名。

每份新素材分配 asset_id 和 file_key，file_key 是受控文件 UUID，由宿主拼接到 media 目录；不允许用户任意填写绝对路径。素材 ID 是业务身份，file_key 是物理定位，两者用途不同。旧文件迁移可令 file_key 继续使用原文件 UUID，不改旧素材 ID 或搬走原文件。

文件创建后保持不可变。重新导入、重生成创建新素材 / 新文件；恢复同次结果保存则复用已经持久登记的 asset_id / file_key，不能在每次重试产生新 ID。暂不按 hash 自动去重或共享跨画布素材。

### 5.2 `canvas_assets`：统一素材表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| canvas_id / id | TEXT | PK(canvas_id, id)，id 就是被引用的 asset_id |
| kind | TEXT | CHECK(image / video / audio) |
| mime | TEXT | 识别出的真实 MIME |
| filename | TEXT | 显示 / 下载文件名，不用作磁盘路径 |
| file_key | TEXT | media 内的受控文件 UUID |
| bytes | INTEGER | 实际文件字节数 |
| file_hash | TEXT / NULL | 文件字节 SHA-256；已核验可用文件必须有，旧缺失文件可 NULL |
| file_state | TEXT | ready / missing，明确磁盘可用状态 |
| width / height / duration | INTEGER / REAL / NULL | 可读取的尺寸 / 时长，音视频编码仍依赖浏览器 |
| origin_kind | TEXT | upload / generated，记录素材来自导入还是任务生成 |
| origin_node_id / origin_task_id | TEXT / NULL | 来源线索，保留历史；不随节点删除级联删除 |
| content_hash / row_version | TEXT / INTEGER | 素材元信息的内容摘要与版本 |
| created_at / updated_at | INTEGER | 时间戳 |

file_hash 校验文件字节，content_hash 校验元信息；文件哈希不等于节点哈希。ready 素材的 bytes / mime / file_hash 应与实际文件匹配；缺失时不伪造已恢复状态。来源 ID 只用于溯源，当前引用关系以节点、边和任务关联表为准。

文件 SHA-256 在写入、迁移或对账时计算，不在每次播放 / Range 请求或移动节点时重读整个视频计算。恢复已登记素材时，如果重新取得的文件与已有 file_hash 不符，拒绝覆盖旧文件，保留恢复错误供处理。

### 5.3 数据表怎样引用素材

| 引用位置 | 引用字段 / 关联 | 表达的意思 |
| --- | --- | --- |
| canvas_nodes（资源节点） | asset_id | 节点当前持有的图片 / 视频 / 音频 |
| canvas_nodes（生成节点） | selected_result_id | 当前预览的一份生成结果；不代表全部输出 |
| task_outputs | canvas_id + task_id + output_order → asset_id | 同次任务的全部已保存输出及顺序 |
| canvas_edges | asset_id | 这条边实际传给下游的具体素材 |
| task_references | canvas_id + task_id + reference_order → asset_id | 提交时使用的具体素材，后续编辑不改变它 |

上述素材引用统一通过 `(canvas_id, asset_id)` 指向 canvas_assets 的复合主键，禁止跨画布误引用，资产删除采用 RESTRICT。生成节点的 asset_id 保持 NULL；生成结果由 task_outputs 管理，selected_result_id 只选择预览。端点关系仍只存 node_id，不在那里再存文件路径 / 重复 asset_id。

例如下列均为示意 ID，实际使用 UUID：

```text
画布 C1，生成节点 N1，任务 T1 输出两张图片

task_outputs:
  (C1, T1, output_order=0) → A1
  (C1, T1, output_order=1) → A2

canvas_assets:
  (C1, A1) → file_key=F1 → media/F1
  (C1, A2) → file_key=F2 → media/F2

canvas_nodes[N1].selected_result_id = A2  当前查看第二张
canvas_edges[E1].asset_id = A1           下游仍引用第一张
```

同一素材可以被同画布内多个节点 / 边引用，不复制文件。切换预览或重生成不会覆盖 A1 的文件，也不会使 E1 自动改为其他素材。视频 / 音频文件使用同样的素材表结构；当前协议没有音频生成，音频资源的导入 / 播放可直接沿用这套引用。

### 5.4 保存与读取的一致性

| 操作 | 拟议处理 / 可观察结果 |
| --- | --- |
| 导入 / 保存输出 | 流写临时文件，同时计算 bytes 和 SHA-256；检查体积 / 格式后 fsync、落到最终 file_key，再事务登记可用 Asset；生成结果同时关联 task_outputs |
| 保存成功 | 文件落位和元信息事务成功后才返回可用素材；随后读取同一宿主可见该记录 |
| 输出重试 | 使用原任务输出描述和固定 ID，核对已登记文件后继续，不重新提交生成 |
| 建立引用 | 事务内校验同画布、素材 ready、来源归属、模型接受类型，再保存节点 / 边引用 |
| 浏览器播放 / 下载 | 用 canvas_id + asset_id 访问认证媒体接口；宿主查 Asset 再定位 media/file_key，按 mime 返回文件流 / Range，不暴露绝对路径 |
| 缺文件 / hash 不一致 | 明确不可用，保留节点和任务供恢复；不会悄悄改到其他素材或自动重新生成 |

素材新增不回写整张图；新资源节点或新连线随后作为独立图增量提交。用户应区分“文件上传完成”与“新节点 / 连线保存完成”，与现有流程一致。服务数据读取和图保存仍按 canvas_id 分区，并校验画布 owner_id。

文件落位与 SQLite 不能组成一个跨介质事务：落盘成功、DB 提交前崩溃会留下孤立文件；维护者按 DB 引用、私有 pending 输出描述及文件清单对账，不能仅因节点当前没显示就删除文件。磁盘失败时保存明确失败，不承诺自动 failover。

不用画布 JSON 内嵌 Base64，不把大媒体字节作为 SQLite BLOB，不以供应商 URL 作为唯一存储。小型素材元信息仍在 SQLite，临时供应商地址 / 私有恢复信息不进入公开图 DTO。

### 5.5 引用查询与文件保留

资产主键覆盖按素材 ID 定位。额外建议：

| 索引 | 用途 |
| --- | --- |
| canvas_assets(file_key) | 查某磁盘文件被哪些资产记录使用，不设置唯一，兼容旧文件映射 |
| canvas_nodes(canvas_id, asset_id) WHERE asset_id IS NOT NULL | 当前资源引用 |
| canvas_nodes(canvas_id, selected_result_id) WHERE selected_result_id IS NOT NULL | 预览引用 |
| canvas_edges(canvas_id, asset_id, id) | 下游输入引用，沿用前文已有索引，不重复建立 |
| task_references(canvas_id, asset_id, task_id) | 任务快照对素材的引用 |
| task_outputs(canvas_id, asset_id, task_id) | 历史任务输出归属 |

task_outputs 按任务取批次顺序使用其主键，不另建重复索引。file_hash 暂只做写入 / 对账校验，没有按 hash 搜索或自动去重需求，不先建立大哈希索引。

删除节点 / 边不会立即删除文件；画布逻辑删除也暂保留素材与任务。未来真正回收文件前，需要核对全部资产记录、节点、边、任务输入 / 输出及 pending 恢复描述，不只查看 selected_result_id。尚未定义回收功能时维持保留策略，不在本期新增自动 GC。

### 5.6 任务与旧数据兼容

画布内部既有功能仍需以下配套表，不能只存节点和边后丢掉生成结果：

| 配套表 | 作用 / 主要关联 |
| --- | --- |
| `canvas_assets` | PK(canvas_id, id)；素材类型、文件名、bytes、受控 file_key / file_hash、缺失状态与元数据；字节仍在 media |
| `generation_tasks` | PK(canvas_id, id)；历史 node_id、status、sequence_no、model / prompt / params 快照、供应商 ID、进度 / 错误；不对历史 node_id 做级联删除 |
| `task_references` | PK(canvas_id, task_id, reference_order)；asset_id；提交素材快照的唯一存储来源 |
| `task_outputs` | PK(canvas_id, task_id, output_order)；asset_id；重建旧 resultIds 和批次顺序 |
| `migration_imports` | 旧 workspace source_key 到新 canvas_id 映射、源 hash、导入 checkpoint 和核验状态 |

为任务最新批次建立 `(canvas_id, node_id, sequence_no DESC)` 索引；tracked 状态按 `(canvas_id, node_id)` 做 partial UNIQUE，保留同节点只有一项未结束任务。素材 / 任务变化不修改 graph_revision。模型 / 密钥及私有 issued / 未保存输出恢复文件暂沿用现有受限文件。

SQLite 与媒体 / 私有恢复文件不是跨介质事务，仍需先落文件再登记、失败对账，不声称本方案已经消除所有崩溃窗口。当前引用规则不变：重生成 / 切预览不改旧边，资源主动重新导入会替换其出边，历史任务快照不变。

迁移不修改旧 JSON 文件内容或已有媒体 ID。每个旧工作区的现有画布导入为一张普通画布，映射存 migration_imports；不把旧工作区变成强制业务文件夹。名称使用可查重的“原有画布 1”等普通名称，保留旧 node / edge / task / asset ID 及数组顺序。

| 阶段 | 处理与回退 |
| --- | --- |
| 新增 | 新建独立 staging SQLite，旧文件仍为权威 |
| 导入 | 停止旧写入，分批 / checkpoint 导入，源 hash 变化或校验失败即停止 |
| 核验 | 数量、原 DTO 内容、hash、两角色端点、素材引用、任务恢复核对 |
| 切换 | 全部核验后单写者切换；迁移期间不启动供应商请求 |
| 保留 | 旧文件和备份暂不清理；有 SQLite 新写后不能直接回退到陈旧 JSON，需反向导出核验或修复新路径 |

## 6. 实施前需验证的数据库条件

推荐 WAL、foreign_keys=ON、synchronous=FULL、短事务和单宿主写者。同步 node:sqlite 可能阻塞宿主线程，事务内不下载媒体或调用供应商；批次上限 / busy_timeout 先作为设计参数，负载测量后确定。

本机无副本 / 自动 failover；写锁、磁盘失败要显式失败并保留草稿。新增 hash / 索引 / receipt 仍有 WAL 写放大；用 EXPLAIN QUERY PLAN 验证上述查询，监测事务时间、锁等待和 WAL 大小，不凭分表承诺性能。

数据库及日志文件维持当前 OS 用户权限；owner_id 条件在宿主校验，不接受客户端任意指定。UUID 保留、版本 / 序号采用非负 INTEGER，并在 JS 安全整数边界前拒绝溢出。

迁移先在副本验证，按有界批次推进；Schema、hash、FK、恢复凭据、权限、磁盘错误均阻止切换。备份必须包括 SQLite 一致快照、媒体和私有恢复文件；运行时不能只复制 db 漏掉 WAL。

验收重点：改一个节点只写受影响行；边和两端原子；重命名不重写图；重复请求不重复保存；跨画布连接拒绝；旧数据导入不丢引用 / 任务；节点删除不留悬空边；日志过期明确重载。

本次只产出上述设计，没有建库、迁移、修改业务代码或替换旧存储决策。
