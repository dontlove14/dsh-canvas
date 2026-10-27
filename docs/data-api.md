# 数据与 HTTP 接口参考

文档类型：参考；负责人：项目维护者；最近核对：2026-10-27。契约 / Schema / 路由变更时复核。

可执行事实：[contracts](../src/shared/contracts.ts)、[v2](../src/shared/v2.ts)、[schema.sql](../src/host/persistence/schema.sql)、[service](../src/host/service.ts)。业务行为见[业务参考](business.md)，配置限额见[运行指南](operations.md)。

## 对象与身份

新目录 / 节点 / 模型 / 素材 / 本地任务 / 边使用 UUID；迁移画布 ID 保留长度 1–512 的旧字符串。名称 trim / NFC 后 1–160；模型名最长 120。时间为毫秒数。图 / 宿主投影 DTO 保留 version 1，不表示维护另一套画布模式；SQLite `user_version=2`，API 使用 v2。

| 对象 | 字段 |
| --- | --- |
| ModelRecord | id、kind image/video、name、model_id、api_base、protocol；Base 为无账号 / 查询 / 片段的 HTTP(S)，最长 2048 |
| ModelInput / PublicModel | 输入可选 api_key（最长4096）；缺省保留、空串清除。读取仅 has_api_key、api_key_mask、capabilities |
| CanvasNode | id、kind 六种节点、title、position x/y 有限、modelId/null、prompt≤32000、params/null、assetId/null、selectedResultId/null |
| CanvasEdge | id、source、target、assetId |
| CanvasGraph | version、nodes、edges、viewport x/y 有限、zoom 0.05–4 |
| Asset | id、kind、filename、mime、bytes、nodeId/null、taskId/null、createdAt；可选 width / height / duration |
| TaskSnapshot | model、prompt、params、referenceIds；不含 Key，SQL references 另存 file_hash |
| TaskSummary | id、workspaceId、nodeId、status、progress?、resultIds、createdAt、updatedAt；无 snapshot / providerTaskId / error |
| CanvasSnapshot | version、workspaceId、graphRevision、graph、assets、任务摘要、updatedAt、commitHash、hashes nodes/edges/viewport |
| TaskDetail | kind、task（生成完整 DTO，导入为 null）、phase、externalTaskId、externalCompletedAt、successAt、failureStage / Code / Message、attempts |

图校验拒绝重复 ID、悬空端点 / 素材、非生成目标、错误来源归属、重复参考与环；资源类型 / 结果归属和未结束任务删除另验。生成参数按[协议能力](providers.md)校验，参考文件 hash 在发送前复核。所有 assets / tasks 由宿主维护，不接受客户端全量回写。

GenerationParams仍为size≤32、n整数1–10、seconds可选整数。0.2.17只将n上限由4放宽到10；secondsRange={min,max,step}为可选派生ModelCapabilities，优先于seconds固定列表，不进入ModelRecord / CanvasNode / TaskSnapshot或SQLite新字段。生成校验按范围 / 步长或固定值检查并要求视频时长>0，图草稿允许0秒。存量结构及内容保持；新存n>4不能由旧上限4版本直接读取，回退条件见[ADR-0029](adr/0029-generation-sliders-and-audio-wheel.md)。

0.2.18新增领域kind=`tts-generation`，modelId / assetId必须null，params为 `{type:"tts",reference_id:最长512文字,speed:有限正数,volume:有限数}`，默认空音色ID / 1 / 0，prompt复用文字字段。无输入连线；输出仍绑定该节点任务的具体音频assetId。TTS快照model为固定kind=audio、name=FishTTS、model_id / protocol=fish-tts、服务身份UUID和完整api_base；params为TTS参数，referenceIds空，无Key。SQLite **DDL / user_version不变**：只将TTS领域kind编码到已有audio-asset行，严格TTS参数的type标记用于加载还原；hash / 回执使用领域对象，旧行不重写。旧版不支持新TTS参数 / 快照，见[ADR-0030](adr/0030-fish-tts-nodes-and-streamed-audio.md)。

0.2.19情绪徽章只是显示：已知 `(calm)` 显示 `@平静`，序列化 / 复制 / 提交保留同一原始字符串；未知括号保留正文。不会把中文名、HTML或素材UUID写入prompt，不改写历史行 / hash。

提示词@标签复用CanvasNode.prompt，序列化为 `{{asset:UUID}}`。图保存允许失效标签作为待修正草稿；生成拒绝不存在或未在referenceIds中的素材。Service按本次入边顺序解析为 `[参考图N]` 后保存TaskSnapshot.prompt，referenceIds仍是原始有序ID；节点原字符串不修改。没有新增DTO / 表 / 索引，历史纯文本保持；详见[ADR-0027](adr/0027-prompt-asset-mentions.md)。

## SQLite 表与索引

当前 **21 表、39 条显式索引**；SQLite PK / UNIQUE 自动索引另外计。完整列 / CHECK / FK 以 schema 为准，提案仅解释设计，不冒充实际 DDL。

| 表族 | 实际表 |
| --- | --- |
| 目录 / 存储 | storage_roots、owner_settings、folders、canvases、canvas_storage_locations |
| 图 / 素材 | canvas_assets、canvas_nodes、canvas_edges、edge_node_relations、canvas_state |
| 回执 | canvas_mutations、catalog_mutations |
| 任务 | task_catalog、task_details、task_attempts、task_references、task_outputs |
| 上传 / 文件 / 迁移 | upload_sessions、file_operations、file_operation_items、migration_imports |

task_catalog 只存归属、种类、title 摘要、queue_seq、status、progress 和时间。详情 1:1，存 request_id/hash、snapshot_json、credential_ref、phase、due / lease、submit_issued、external_task_id / status / completed_at、success_at、failure 字段、私有 outputs_json / import_json。

目录任务 status：queued、running、external_wait、saving、succeeded、failed、needs_attention、save_failed、abandoned。图摘要分别映射 submitted、generating、queued、saving、completed、failed、unknown、save_failed、abandoned。task_active_node 部分唯一索引包含未结束与需要处理状态。

边的两端在 edge_node_relations（source / target），复合 FK 保证端点 / 素材同画布。任务历史不以 node FK 绑定已删除节点。素材 ready 要求实际位置、MIME、字节与 hash 齐全。CAS / FK 失败整批回滚，runtime token 拒绝过期写者。

## 任务搜索与分页

task-search的taskId为完整UUID（大小写规范到小写），精确匹配；folderName / canvasName为trim / NFC后的1–160字符字面包含，不把 `%` / `_` / `\`当通配符。type为image / video / tts / import，从任务提交快照与kind派生。startTime / endTime是0–8640000000000000的整数毫秒，按任务created_at包含两侧端点，可只提供一侧；开始晚于结束返回400。UI用浏览器本地时区，精确到秒，结束秒补999ms。

page为1–100000000，pageSize只允许10 / 20 / 50 / 100。按queue_seq降序，首查返回owner活动画布的最大序号upperBound（0–MAX_SAFE_INTEGER）；翻页 / 改条数沿用，查询 / 重置不传以获取新上限。总数与行数据由同一Worker消息计算，超范围页返回最后一页，空结果返回page=1。名称、状态与删除仍实时读取，不承诺跨请求完整快照。未知 / 重复参数、非整数字段、非法UUID / 类型均400。

TaskRow仅含id、canvasId、nodeId、folderName、canvasName、nodeName、type、公开status、createdAt、updatedAt。文件夹 / 画布为当前目录名，未归档显示“未归档”；nodeName为任务title提交快照，导入用其资源节点名。不含凭据、prompt、外部地址、下载URL、完整任务快照。旧tasks原游标 / 原DB状态不变，task详情和POST动作不变。无DDL / user_version变动；见[ADR-0035](adr/0035-searchable-paginated-task-dialog.md)。

## 增量保存

POST graph：

```json
{
  "mutationId": "UUID",
  "baseRevision": 0,
  "nodes": [{"value": "CanvasNode对象", "hash": "64位SHA256"}],
  "edges": [],
  "deleteNodes": [],
  "deleteEdges": []
}
```

可选 viewport 为 `{value:{x,y,zoom},hash}`。规范化 JSON：对象字段按字典序、忽略 undefined，数组保留顺序；SHA-256 hex 小写。每批最多10000个节点 upsert、20000条边 upsert；不构成全图容量保证。

实际图改变推进 graph_revision；无变化不推进。提交链 `SHA256({prevCommitHash,revision,changes})`，用户与后台图变更都有 receipt；任务进度不推进。重复 mutationId 相同内容返回**当前快照**及 `mutation:{id,replay,revision,commitHash,hasChanges}` 原回执；相同 ID 不同内容拒绝。GET afterRevision 返回最多100个变更、nextRevision、hasMore，客户端需循环到当前修订。

## HTTP 路由

根路径 `/api/canvas/v2`，由 Harness connection 提供 owner 认证，JSON no-store。下表画布范围接口均带 query `canvas`，任务 / 素材另带 UUID `id`。输入严格 Schema。

| 方法 / 后缀 | 输入 | 返回 |
| --- | --- | --- |
| GET / POST models | POST ModelInput | `{models}` |
| POST model-delete | query id | `{models}` |
| GET catalog | 无 | `{folders,canvases}`，包括修订 / hash / 搬移状态 |
| POST catalog | requestId、operation；按动作 id/name/folderId/revision | `{id}`；folder-create/rename/delete，canvas-create/rename/move/delete |
| GET graph | canvas；可选 afterRevision | CanvasSnapshot 或增量页 |
| POST graph | 增量批次 | 当前 snapshot + mutation 回执 |
| POST generate | requestId、nodeId、revision | 202 TaskSummary；目录 / 详情已提交 |
| POST mock-generate | requestId、nodeId、revision | 202 TaskSummary；仅允许内置Mock模型，图片 / 视频UI调用此入口 |
| POST tts-generate | requestId、nodeId、revision | 202 TaskSummary；仅语音节点，hash含tts:true、缺配置TTS_NOT_CONFIGURED |
| GET / POST tts-settings | POST endpoint、revision、api_key? | 公开endpoint、revision、configured、has_api_key、api_key_mask；缺api_key保留，空串清除；修订冲突SETTINGS_CONFLICT |
| GET tasks | canvas、cursor queue_seq，默认0 | `{items,nextCursor}`，每页50个目录摘要 |
| GET task-search | taskId / folderName / canvasName / type / startTime / endTime可选；page默认1、pageSize默认20、upperBound可选 | `{items,total,page,pageSize,upperBound}`，owner范围未删除画布，目录派生DTO；不需要canvas |
| GET task | canvas、id | TaskDetail，不返回私有下载 URL / Key |
| POST task | id、action retry-save/resume-query/abandon | `{ok:true}` |
| POST upload-start | requestId、filename、kind、position | 201 `{id,nodeId}`，资源占位已保存 |
| POST upload | canvas、id 会话、kind；原始字节流、URL编码 x-canvas-filename | 202 `{taskId,nodeId}`，完整接收后导入任务已提交 |
| GET / HEAD media | canvas、id；download 可选；variant=preview&v=1 或 variant=waveform&v=1 可选 | 原文件 / WebP封面200/206、音频波形JSON200，HEAD无body；不可用404 |
| GET / POST storage | POST requestId、path Host绝对路径、revision | `{path,revision,moving,failed}` |
| POST storage-retry | 无 | `{ok:true}`，失败清单重新排队 |

旧 `/api/canvas/workspace` 仅 GET 投影保留，旧 mutation 接口不再写入；服务内 legacy models alias 兼容，但 Harness 仅注册新 models 路由。旧 JSON / 媒体仍作为只读迁移来源，不双写。

Mock模型来自[固定共享定义](../src/shared/mockModels.ts)，不写入models.json，不需要凭据。任务快照仍是严格ModelRecord，只有身份 / 名称 / 协议 / 地址全部匹配内置记录时才允许无凭据本地执行。mock-generate的幂等hash包含mock:true，与generate不可共用requestId。输出ID由任务ID和序号确定，写入同一task_outputs / canvas_assets，复用既有尺寸 / 时长字段；不新增表、节点、边或任务DTO字段。0.2.11起只渲染当前主图的默认输入 / 输出端点，移除result:assetId逐结果端点；展开状态不进入增量DTO。已有边的assetId保留，新连接仅使用主图；不迁移或删除历史引用。

上传为 streaming，不是 multipart / Base64 控制请求。按实际流检查大小与格式，不能以 MIME / 声明长度跳过检查。202 不代表任务成功，接收中断没有可恢复后台导入承诺。

原媒体 / 封面返回 MIME、nosniff、Accept-Ranges、私有缓存和 UTF-8 Content-Disposition。原媒体不可变缓存；preview仅图片 / 视频，返回image/webp、private/max-age=3600。版本缺省1，其他版本或variant拒绝；原文件下载使用不含variant的路径。归属和原文件路径检查在派生处理前执行。原媒体 / 封面只支持单段bytes Range，非法 / 多段416。文件指针或缓存发生外部符号链接替换拒绝；路径不可用返回JSON错误。没有ETag或条件请求。

waveform仅音频，返回 `{version:1,duration:实际解码秒数,peaks:96项0–1幅度}`，application/json、private/max-age=3600、nosniff；HEAD含同一Content-Length但无body，不支持Range / download。JSON是派生缓存，不新增DTO字段 / 表，失败422或503 `WAVEFORM_UNAVAILABLE`，原文件读取仍独立。算法 / 限额见[ADR-0028](adr/0028-audio-waveforms-and-compact-prompts.md)。

## 文件与凭据布局

```text
dataDir/
  canvas.sqlite                 结构数据（运行时可能有 -wal / -shm）
  .writer/pid                  与旧版协调
  models.json                  公开模型配置
  model-bindings.json          modelId → credentialRef
  tts-settings.json            FishTTS endpoint / revision / service ID / credentialRef，无Key
  vault/                       仅开发 LocalVault 明文版本文件
  staging/                     上传 / 输出暂存，当前保留
  previews/                    派生WebP封面，无数据库字段；停机后可删除重建
    waveforms/                 派生音频幅度JSON，同样可停机删除重建
  workspaces/ tasks/ credentials.json  若存在：旧只读来源
mediaRoot/画布安全名称/资源安全名称__身份后缀.png|mp4|...
```

新建目录0700、文件0600。Harness Key 存于 ctx.credentials 提供方，备份须同时备份其持久记录；dataDir 单独复制不包含这些 Key。模型配置仍 JSON，凭据与 SQL 不跨介质原子。

## 主要错误

错误 JSON `{error,code}` 脱敏并不缓存；认证层另行处理。常用：400 INVALID_REQUEST；404 NOT_FOUND / MODEL_NOT_FOUND / MEDIA_MISSING；409 GRAPH_CONFLICT / HASH_MISMATCH / REQUEST_REUSED / CATALOG_CONFLICT / STORAGE_CONFLICT / NAME_EXISTS / FOLDER_NOT_EMPTY / NODE_BUSY / CANVAS_BUSY / TASK_CREDENTIALS_MISSING / UNSAFE_PATH / SNAPSHOT_REQUIRED / MEDIA_CHANGED；413 MEDIA_TOO_LARGE；415 UNSUPPORTED_MEDIA；422或503 PREVIEW_UNAVAILABLE / WAVEFORM_UNAVAILABLE（原文件仍走原接口）；429 QUEUE_FULL；503 WRITER_FENCED。

STORE_LOCKED / MIGRATION_SOURCE_CHANGED 属启动失败。普通 OS / SQL 异常可能使用400通用错误；没有宣称所有异常均有独立业务 code。owner 范围是整个实例，当前没有多用户 ACL / 跨设备同步。
