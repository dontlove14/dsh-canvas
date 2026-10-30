# 数据与 HTTP 接口参考

文档类型：参考；负责人：项目维护者；最近核对：2026-10-30。契约 / Schema / 路由变更时复核。

可执行事实：[contracts](../src/shared/contracts.ts)、[v2](../src/shared/v2.ts)、[schema.sql](../src/host/persistence/schema.sql)、[service](../src/host/service.ts)。业务行为见[业务参考](business.md)，配置限额见[运行指南](operations.md)。

## Agent 控制与工具

0.2.91 仅主级增加三项工具，HTTP 注册数量仍为38。`canvas_inspect` 与动态上下文增加 `userMedia:[{type,attachmentId,messageId,name,bytes,mime?}]` 和实际 `workspace`；只接受根会话用户附件，子级不获取附件读写或文件工具。关键主级工具可提供 `note`（1–180字符），用于实际工具调用过程说明，不改变业务结果或生成授权。呈现 action 增加 `import`。

| 工具 | 主要输入 | 成功 / 错误及重试 |
| --- | --- | --- |
| canvas_import_attachment | operationId(UUID)、revision、attachmentId、kind(image/video/audio)、purpose(1–500字符) | 真实 nodeId / taskId、queued、referenceReady=false；原任务成功后 inspect 获得 assetId 再 connect。不读任意路径或 URL；403 ATTACHMENT_FORBIDDEN、413 MEDIA_TOO_LARGE、415 UNSUPPORTED_MEDIA、409 AGENT_CONTROL_REVOKED。相同操作 ID 复用上传身份，改变内容拒绝 |
| canvas_document | operationId、document:{title,content,category} | category 为方案/简报/资产/分镜/镜头/音频/审查/其他；Markdown≤32000字符；返回 file:{path,relativePath,bytes,sha256}；当前根受控写入，无任意目的地字段 |
| canvas_export_media | operationId、assetId、userRequest(1–500字符) | 仅用户要求下载；当前画布 locator 流式读取并验证原 bytes / sha256，返回 assetId / file，不提交生成。413大小限制、409 FILE_HASH_MISMATCH |

`canvas_open` 新建返回实际 folderName / folderCreated，先建立「Agent 创作」，已有画布与用户手动移改的重试不强制搬回。`canvas_review_plan` 在原生提问前保存完整方案，返回 approved / answers / file；`canvas_draft` 与主级 `canvas_specialist` 增加完整文档 file。工具仍用真实 Agent scope / 原 roster / epoch 约束。工作区目录拒绝符号链接，文件无覆盖发布；409 UNSAFE_PATH / FILE_COLLISION / WORKSPACE_CHANGED 不回放旧目录、不覆盖用户编辑。目录项目名和上传位置固定回执沿用 AgentLedger v1 的 receipts，不改持久 Schema。最小流程：inspect 获取用户附件 → open → import_attachment → task 查询至成功 → inspect 实际素材 → create_node / connect → 本轮授权下 generate。详见[ADR-0074](adr/0074-agent-reference-import-workspace-and-progress.md)。

0.2.90 更正 `canvas_review_plan` 的原生服务参数：question.detail 仍为完整 Markdown，intent 为 `{kind:"plan-review",approve:"确认方案"}`，不带历史展示 `callId`；真实工具 ID 保留在 `wait.callId`。工具输入 / 返回和所有 HTTP 路由保持。正文用原生临时 `params.planReview.markdown` 展示，不建立永久历史计划资源，见[ADR-0073](adr/0073-native-canvas-plan-detail-preview.md)。

0.2.89 增加五个 owner 认证呈现路径（V2 注册总数 38），只承载 UI 元数据。均复用 Harness 原 Connection.fetch 身份；agent-view / ack 的 URL canvas 必须等于 body.canvasId，session / epoch 必须匹配当前 Agent 控制。多余字段和非法值拒绝 400，旧身份返回 409 `PRESENTATION_STALE`，未呈现版本返回 `PRESENTATION_NOT_READY`，独立文件损坏返回 503 `PRESENTATION_INVALID`。读取和报告不提交任务、不修改图。

| 路径（`/api/canvas/v2/`） | 输入 / 输出 | 语义 |
| --- | --- | --- |
| `GET agent-presentation?sessionId=...` | `{intent:null或{id,sessionId,canvasId,epoch,action,graphRevision,nodeIds,taskId?,createdAt}}` | 当前有效控制下最新意图，无则 null；no-store |
| `GET agent-presentation-events?sessionId=...` | text/event-stream，data 为同一状态；2 秒心跳 | 初始与变化发送，重连读取最新状态，不重放旧操作；关闭流随 Host 释放 |
| `POST agent-presence` | `{sessionId,viewId,visible}` → `{ok:true}` | 前台当前会话报告，5 秒时效 |
| `POST agent-view?canvas=...` | `{sessionId,canvasId,epoch,viewId,sequence,visible,following,center?,width?,height?,zoom?,sizes?}` → `{ok:true}` | 有序实际容器坐标与节点尺寸；5 秒有效，30 秒清过期 |
| `POST agent-presentation-ack?canvas=...` | `{sessionId,canvasId,epoch,viewId,presentationId,graphRevision,status,reason?}` → `{ok:true}` | status 为 presented / paused / deferred / failed，presented 要求新鲜可见跟随视野与对应版本 |

最小报告：`POST agent-presence`，JSON `{"sessionId":"<当前会话>","viewId":"<本窗口UUID>","visible":true}`；成功 200。报告仅改变临时观察状态，不绕过控制权成为写接口。intent action 为 open / create / update / connect / generate；ID 包含当前 epoch，重复操作沿原回执，taskId 仍是原持久任务。

`canvas_create_node` 原 position 变为可选；`placement:{group:"assets"|"shots"|"audio",anchorNodeId?:string}` 默认按节点种类选组，显式 position 优先。输出增加 `{placement:{position,source},presentationId,presentation:{id,status,reason?}}`，source 为 explicit / visible-viewport / fixed-origin / existing-node / saved-viewport。`canvas_inspect` 增加 presentation / 临时 view / 节点布局，写操作返回真实提交后的呈现结果；8 秒等待不占提交队列。失败 / 暂停 / 延后不得重提生成，先检查原 taskId 与当前控制 / 意图。

0.2.84 共 33 个注册路径，新增四个 owner 认证接口。CanvasGraph 和主库 DDL 不变；独立 `agent-ledger.json` 格式版本 1 保存控制、草稿、幂等回执、任务提交归属和交接基线。原 `graph` 响应新增可选 `agentControl`。

| 路径（`/api/canvas/v2/`） | 输入 / 输出 | 语义 |
| --- | --- | --- |
| `GET agent-session?sessionId=...` | `{preset,canvas}` | 是否为无限画布预设、最近附属画布；客户端自动打开侧栏 |
| `GET agent-models` | `{models:[{provider,providerName,model,name,eligible}]}` | 明确 image 输入才 eligible；仅元数据核验 |
| `GET agent-control?canvas=...` | `{canvasId,sessionId,mode,epoch,updatedAt,reason?}` | 只读控制状态 |
| `POST agent-control?canvas=...` | `{action:"delegate",sessionId,revision}` 或 `{action:"takeover"}` → 控制状态 | 委托先保存当前 revision；接管先同步撤权 |
| `GET agent-drafts?canvas=...` | `{drafts:[{id,canvasId,kind,title,content,version,dependencies,assetIds,author,createdAt,baseRevision,epoch,needsReview}]}` | 版本与依赖按明确身份保存，最多 10000 条 |

最小控制请求：`POST /api/canvas/v2/agent-control?canvas=<真实画布ID>`，JSON `{"action":"delegate","sessionId":"<无限画布会话ID>","revision":<已保存版本>}`。成功 200；404 画布不存在；409 `GRAPH_CONFLICT`、`AGENT_CANVAS_BUSY`、`AGENT_SESSION_BUSY` 或 `AGENT_CONTROL_REVOKED` 时先读取新状态，不自动重提生成。协作期间人工写入返回 409 `CANVAS_READ_ONLY`。不合格模型返回 `AGENT_MULTIMODAL_REQUIRED`，记录读取失败关闭 Agent 功能，返回 `AGENT_LEDGER_INVALID`。开发实例无 Harness Agent 服务时返回 503 `AGENT_UNAVAILABLE`。

0.2.85 原生 Typert `agentPresets/list` 保持 `{presets:[...]}` 协议，只从用户目录过滤五个精确内部预设 ID，主级显示为「视频创作」。默认标记、排序、其他预设和原请求权限保持；内部原生 `resolve` / `mount` / `list` 仍包含子预设供 spawn 使用，稳定 ID 与历史会话不迁移。

0.2.88 主级展示名改为「无限画布」，原生协议与稳定 ID 不变。创作模式继续使用 Harness 原模型选择器，directory / load / select 原对象与方法保持，不过滤或替换模型目录。客户端读取 `agent-models`，以精确 provider / model 路由维护原按钮禁用和 title；非多模态提示「非多模态模型，当前 Agent 不支持使用」，未知能力及读取失败分别暂禁。能力请求在菜单打开和目录变更时去重刷新，离开作用域后丢弃迟到结果并恢复原属性。资格仍由原生 `SessionController.selectModel` 和实际 Agent 请求 guard 核验，不合格请求拒绝并返回原生错误。

原生工具由真实 Agent scope 直接调用，不能以客户端参数伪造身份。主级开放 `canvas_open`、`canvas_inspect`、`canvas_method`、`canvas_view_image`、`canvas_task`、`canvas_create_node`、`canvas_update_node`、`canvas_connect`、`canvas_generate`、`canvas_draft`、`canvas_specialist`、`canvas_review_plan` 及 Harness `ask_user_question`。专业级只有五个读取 / 方法 / 查询 / 原生 `structured_output` 工具，不写入、付费生成、再次委派或提问。

0.2.86 新增主级工具 `canvas_review_plan`：`{plan,title?,question?}`，plan 为去首尾空白后 1–32000 字符的 Markdown；title 1–160 字符，默认「创作方案」；question 1–500 字符，默认「请审阅方案，确认后我会按方案继续。」。未知字段与超限输入在打开卡片前拒绝。最小调用 `{"plan":"# 方案\n\n先设计角色，再生成一个5秒镜头。"}`，成功输出 `{approved:boolean,answers:[{id,selected,custom?}]}`。只精确单选「确认方案」且无非空自定义意见时 approved=true；其余有效反馈为 false。

工具直接调用官方 `ctx.userQuestions.ask`，单题 detail 承载完整方案，intent 为 `{kind:"plan-review",approve:"确认方案",callId:<当前原生调用ID>}`；wait 绑定同一调用身份，agent / signal 全程保留，调用与答案进入原生日志。它只展示和返回意见，不写画布、不提交媒体、不持久缓存批准；重复调用会再次询问，提示词要求已有有效授权不重复调用。等待失败沿用原生 `ASK_ABORTED` / `NO_PROVIDER` 等错误，不算通过，不自动重试；接管返回 `AGENT_CONTROL_REVOKED`，未绑定画布的审阅期间若新绑定画布则返回 `AGENT_REVIEW_STALE`，先核对新状态。稳定身份由执行上下文提供，不能在工具参数伪造。普通提问协议不变，后续只做可选字段的兼容扩展；非阻塞计时 / 跨重启恢复问答不属于本次接入。

写入使用稳定 UUID `operationId`，图操作还需当前 `revision`；相同内容复用回执，ID 改内容返回 `REQUEST_REUSED`。生成 requestId 从画布与 operationId 派生，隔离手动请求和其他画布；原任务幂等管线保存实际 taskId。专业委派中断后同 ID 返回 `SPECIALIST_INCOMPLETE`，并发超过 2 返回 `SPECIALIST_CAPACITY`，不会自动重提。工具参数与边界以[预设](../src/host/agent/preset.ts)、[共享契约](../src/shared/agent.ts)为准。

## Seedance预审接口

0.2.54共26个注册路径，全部沿用owner认证。独立[seedance-review.sqlite](../src/host/review/review-schema.sql)保存配置投影、组、任务 / 请求幂等、固定生成来源和脱敏审计，主库23表保持。普通DTO没有原ProjectName、AK/SK、凭据引用或签名URL。

| v2路径 | 方法与契约 |
| --- | --- |
| seedance-review-settings | GET掩码配置；POST provider、revision和可选projectName / accessKeyId / accessKeySecret，空白不替换，AK/SK成对，严格字段 |
| seedance-review-settings-test | POST `{provider}`；使用已保存配置执行ListAssetGroups只读测试 |
| settings-secret | 原单字段POST新增scope=seedance-review、provider、field=projectName / accessKeyId / accessKeySecret；no-store，无query |
| asset-reviews?canvas=... | GET可选assetIds逗号分隔最多100，返回items / revision / busy，只投影当前资源域与原hash；POST requestId、assetId、provider、groupType=AIGC/LivenessFace，真人必填groupId，虚拟不接受自定组；本地接受202 |
| asset-review?canvas=...&id=... | GET单任务详情，返回脱敏原因与官方ID |
| asset-review-action?canvas=...&id=... | POST action=resume/reconcile/retry/abandon；retry必须新requestId且仅failed，unknown可恢复 / 对账 / 结束本地等待 |
| review-groups?canvas=...&provider=... | GET已认证真人组，nextToken分页最长4096，返回items / nextToken；后台确保本画布AIGC组 |

requestId内容不一致409；相同原文件 / 供应商资源域 / 组的活动、通过或待确认记录复用。模型生成新绑定以原生成requestId和snapshotHash持久化，不改变旧快照；恢复缺失返回REVIEW_BINDING_MISSING，原hash不匹配MEDIA_CHANGED。详见[契约](../src/shared/seedanceReview.ts)和[ADR-0059](adr/0059-seedance-asset-review-and-frozen-generation-references.md)。

## 对象与身份

新目录 / 节点 / 模型 / 素材 / 本地任务 / 边使用UUID；画布ID契约允许长度1–512。名称trim / NFC后1–160；模型名最长120。时间为毫秒数。图 / 宿主投影DTO保留version 1，不表示维护另一套画布模式；SQLite `user_version=3`，API使用v2。0.2.37媒体存储契约改为对象定位，旧schema拒绝且不自动导入；以下其他功能版本的“DDL不变”描述只针对其当时改动。

| 对象 | 字段 |
| --- | --- |
| ModelRecord | id、kind image/video、name、model_id、api_base、protocol、可选endpoint_id；Base 为无账号 / 查询 / 片段的 HTTP(S)，最长 2048 |
| ModelInput / PublicModel | 输入可选 api_key（最长4096）；缺省保留、空串清除。读取仅 has_api_key、api_key_mask、capabilities |
| CanvasNode | id、kind 六种节点、title、position x/y 有限、modelId/null、prompt≤32000、params/null、assetId/null、selectedResultId/null |
| CanvasEdge | id、source、target、assetId |
| CanvasGraph | version、nodes、edges、viewport x/y 有限、zoom 0.05–4 |
| Asset | id、kind、filename、mime、bytes、nodeId/null、taskId/null、createdAt；可选 width / height / duration |
| TaskSnapshot | model、prompt、params、referenceIds；不含 Key，SQL references 另存 file_hash |
| TaskSummary | id、workspaceId、nodeId、status、progress?、resultIds、createdAt、updatedAt、requestId?；无 snapshot / providerTaskId / error |
| CanvasSnapshot | version、workspaceId、graphRevision、graph、assets、任务摘要、updatedAt、commitHash、hashes nodes/edges/viewport |
| TaskDetail | kind、task（生成完整 DTO，导入为 null）、phase、externalTaskId、externalCompletedAt、successAt、failureStage / Code / Message、attempts |

图校验拒绝重复 ID、悬空端点 / 素材、非生成目标、错误来源归属、重复参考与环；资源类型 / 结果归属和未结束任务删除另验。生成参数按[协议能力](providers.md)校验，参考文件 hash 在发送前复核。所有 assets / tasks 由宿主维护，不接受客户端全量回写。

GenerationParams为size≤32、n整数1–10、seconds可选整数；0.2.30新增可选background=auto/opaque/transparent、quality=auto/low/medium/high/xhigh/max，旧参数原样读取。sizePresets / backgrounds / qualities为派生ModelCapabilities，不写入ModelRecord，映射规则见[ADR-0037](adr/0037-fixed-provider-image-models.md)。secondsRange={min,max,step}优先于seconds固定列表；生成校验要求视频时长>0，图草稿允许0秒。无DDL / user_version或图结构变化，新字段仅新节点保存，不回填旧数据。

0.2.42增量加入`gemini-image`协议与8个固定Banana模型 / 渠道记录；capabilities新增可选defaultSize，Banana默认1024x1024且counts=[1]。已有params.size映射为供应商比例 / 档位；实际输出宽高仍写入原资产字段。PublicModel只提供has_api_key与掩码，Base64不进入图 / 任务数据库，原模型UUID、schema 3 / DDL及增量DTO保持，见[ADR-0048](adr/0048-banana-native-image-protocol.md)。0.2.43只在适配器内部更正Model Link为generateContent，无新持久协议枚举或节点字段，见[ADR-0049](adr/0049-modellink-banana-generate-content.md)。

0.2.48增加`seedream-image`与六个固定组合。ModelRecord / ModelInput / TaskSnapshot.model可选endpoint_id（trim、≤200、ep-开头）；仅ByteDance / BytePlus Seedream官方配置使用，省略保留原值，启用Key时必填；Model Link与其他协议拒绝。逻辑name / model_id与EP分离，EP不渲染在画布 / 任务中心。旧JSON与快照无需该字段，DDL / user_version / CanvasGraph完全不变；新快照不能交给不支持协议的旧包加载。能力默认2K / 单图，见[ADR-0053](adr/0053-seedream-endpoint-routing-and-model-identity.md)。

0.2.50增加`seedance-video`和十二组合，官方同样使用endpoint_id，Model Link拒绝EP。GenerationParams可选videoMode=text/reference/frames、firstFrameId / lastFrameId为UUID、generateAudio为boolean；size保存真实wire档位 / 比例（如720p/16:9或1080p/adaptive），不伪造输出像素。默认5秒 / 单条 / text / 音频开启。图保存校验模式允许的入边类型 / 数量，生成另验角色 / 引用实际元数据；帧ID绑定既有assetId。task_references仍固定locator_json，执行前流式核验hash再24小时签名，无新字段 / DDL / 路由 / 旧数据回填；不支持Seedance协议的旧包不能读取新快照，见[ADR-0055](adr/0055-seedance-video-modes-and-independent-provider-routing.md)。

0.2.51保留text/reference/frames wire枚举和历史格式，UI只提供reference/frames手动选择；空引用显示text自动状态。图编辑时入边与有效模式一起提交，首连reference、清空text；Host校验 / 新快照按当前引用推导，空的旧reference / frames草稿可生成text。不回填数据库、不修改旧任务snapshot_json或增量hash / requestId语义，见[ADR-0056](adr/0056-seedance-mode-inference-from-references.md)。

0.2.49更正固定Lite配置的model_id为doubao-seedream-5-0-260128 / dola-seedream-5-0-260128，仅models.json原子写回，UUID / EP / Key binding不变，任务snapshot_json保留旧值。无结果提交错误为failed；启动仅将已issued、无外部ID / 输出 / 完成记录的历史needs_attention更正为failed，其他任务身份、尝试和表结构不变，见[ADR-0054](adr/0054-no-result-submission-failure-and-seedream-id-correction.md)。

0.2.18新增领域kind=`tts-generation`，modelId / assetId必须null，params为 `{type:"tts",reference_id:最长512文字,speed:有限正数,volume:有限数}`，默认空音色ID / 1 / 0，prompt复用文字字段。无输入连线；输出仍绑定该节点任务的具体音频assetId。TTS快照model为固定kind=audio、name=FishTTS、model_id / protocol=fish-tts、服务身份UUID和完整api_base；params为TTS参数，referenceIds空，无Key。SQLite **DDL / user_version不变**：只将TTS领域kind编码到已有audio-asset行，严格TTS参数的type标记用于加载还原；hash / 回执使用领域对象，旧行不重写。旧版不支持新TTS参数 / 快照，见[ADR-0030](adr/0030-fish-tts-nodes-and-streamed-audio.md)。

0.2.19情绪徽章只是显示：已知 `(calm)` 显示 `@平静`，序列化 / 复制 / 提交保留同一原始字符串；未知括号保留正文。不会把中文名、HTML或素材UUID写入prompt，不改写历史行 / hash。

提示词@标签复用CanvasNode.prompt，序列化为 `{{asset:UUID}}`。图保存允许失效标签作为待修正草稿；生成拒绝不存在或未在referenceIds中的素材。Service按本次入边顺序解析为 `[参考图N]` 后保存TaskSnapshot.prompt，referenceIds仍是原始有序ID；节点原字符串不修改。没有新增DTO / 表 / 索引，历史纯文本保持；详见[ADR-0027](adr/0027-prompt-asset-mentions.md)。

## SQLite 表与索引

当前 **23表、39条显式索引**；SQLite PK / UNIQUE自动索引另外计。完整列 / CHECK / FK以schema为准，提案仅解释设计。

| 表族 | 实际表 |
| --- | --- |
| 目录 / 存储 | storage_providers、owner_settings、folders、canvases、canvas_storage_locations、storage_targets |
| 图 / 素材 | canvas_assets、asset_variants、canvas_nodes、canvas_edges、edge_node_relations、canvas_state |
| 回执 | canvas_mutations、catalog_mutations |
| 任务 | task_catalog、task_details、task_attempts、task_references、task_outputs |
| 上传 / 文件 / 迁移 | upload_sessions、file_operations、file_operation_items、migration_imports |

task_catalog 只存归属、种类、title 摘要、queue_seq、status、progress 和时间。详情 1:1，存 request_id/hash、snapshot_json、credential_ref、phase、due / lease、submit_issued、external_task_id / status / completed_at、success_at、failure 字段、私有 outputs_json / import_json。

目录任务 status：queued、running、external_wait、saving、succeeded、failed、needs_attention、save_failed、abandoned。图摘要分别映射 submitted、generating、queued、saving、completed、failed、unknown、save_failed、abandoned。0.2.44将task_active_node从部分唯一索引改为同列 / 同谓词的非唯一查询索引，允许同节点多个活动任务；Worker启动事务内检测并升级。仍为schema 3、23表 / 39显式索引，列与业务行保持。

0.2.44的TaskSummary.requestId为可选公开关联ID，由已有task_details.request_id投影；202与快照均提供，用于确切替换临时提交卡片，不新增持久字段。历史按既有tasks / resultIds派生；展开端点result:assetId仅属于ReactFlow界面，存储边仍是source / target / assetId。收起禁止新连接，既有边保留不可见锚点。单次批量主图规则保持，多次提交使用[ADR-0050](adr/0050-submission-history-and-expanded-result-ports.md)。

历史检查沿用认证GET taskDetail中的task.snapshot，校验任务 / 节点 / 画布 / 类型，并按实际任务ID在会话内缓存；不向图摘要添加快照。展开查看没有写入请求；收起后重新点击才恢复最新提交，只更新既有prompt / modelId / params，按原referenceIds恢复已识别UUID标记，不调整边。未接受 / 读取失败不开放生成。无路由、DDL或持久DTO变化，见[ADR-0051](adr/0051-readonly-submission-inspection.md)。

边的两端在 edge_node_relations（source / target），复合 FK 保证端点 / 素材同画布。任务历史不以 node FK 绑定已删除节点。素材 ready 要求实际位置、MIME、字节与 hash 齐全。CAS / FK 失败整批回滚，runtime token 拒绝过期写者。

storage_providers保存不变配置与credential_ref、可轮换read_credential_ref；owner_settings.active_storage_provider_id唯一指定新写入目标。canvas_storage_locations.root_id为providerId，relative_dir为object前缀。canvas_assets保存object_key / etag / version_id / file_hash，asset_variants保存preview / waveform locator_json；task_references固定locator_json，storage_targets固定接受时输出位置。file_operation_items.source_path现在是对象定位JSON，保留列名不表示本地路径。migration_imports仅保留空表，无旧源导入执行器。

ObjectLocator为 `{providerId,objectKey,bytes,mime,sha256,etag?,versionId?,credentialRef?}`；公开Asset DTO不泄露内部凭据引用。任何表均不持久保存OSS签名URL / expiresAt。

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
| GET / POST models | POST ModelInput，新的配置仅允许内置目录身份 / 固定地址 | `{models}`；包含目录占位，PublicModel新增可选configurable，密钥仅掩码 |
| POST settings-secret | strict JSON：model + id + api_key；tts + api_key；storage + id + accessKeyId / accessKeySecret；scope / field为实际字段名 | `{value}`当前配置单字段；owner认证、no-store，只在用户点击眼睛时调用；拒绝GET / query / 任意ref / task / 多余字段，无写入或云端请求 |
| POST model-delete | query id | `{models}` |
| GET catalog | 无 | `{folders,canvases}`，包括修订 / hash / 搬移状态 |
| POST catalog | requestId、operation；按动作 id/name/folderId/revision | `{id}`；folder-create/rename/delete，canvas-create/rename/move/delete |
| GET graph | canvas；可选 afterRevision | CanvasSnapshot 或增量页 |
| POST graph | 增量批次 | 当前 snapshot + mutation 回执 |
| POST generate | requestId、nodeId、revision | 202 TaskSummary；目录 / 详情已提交 |
| POST mock-generate | requestId、nodeId、revision | 保留旧适配器 / 协议回归入口；当前画布不调用，只提交真实generate / tts-generate |
| POST tts-generate | requestId、nodeId、revision | 202 TaskSummary；仅语音节点，hash含tts:true、缺配置TTS_NOT_CONFIGURED |
| GET / POST tts-settings | POST endpoint、revision、api_key? | 公开endpoint、revision、configured、has_api_key、api_key_mask；缺api_key保留，空串清除；修订冲突SETTINGS_CONFLICT |
| GET tasks | canvas、cursor queue_seq，默认0 | `{items,nextCursor}`，每页50个目录摘要 |
| GET task-search | taskId / folderName / canvasName / type / startTime / endTime可选；page默认1、pageSize默认20、upperBound可选 | `{items,total,page,pageSize,upperBound}`，owner范围未删除画布，目录派生DTO；不需要canvas |
| GET task | canvas、id | TaskDetail，不返回私有下载 URL / Key |
| POST task | id、action retry-save/resume-query/abandon | `{ok:true}` |
| POST upload-start | requestId、filename、kind、position、size? | 201 `{id,nodeId}`；size开启续传，同UUID不同输入409 REQUEST_REUSED |
| GET upload-status | canvas、id | `{id,nodeId,size,offset,chunkBytes,state,taskId?}`；服务器已持久确认的offset，独立buffered路由，no-store |
| POST upload | canvas、id、kind、offset；原始分块、URL编码x-canvas-filename、x-canvas-chunk-sha256 | 200 UploadStatus；严格边界与hash，进度冲突409 UPLOAD_OFFSET_MISMATCH；旧无size / offset全文件流仍返回202导入 |
| POST upload-complete | canvas；`{id}` | 202 `{taskId,nodeId}`；仅完整 / 格式验证后接受，重复返回原任务，未完成409 |
| POST upload-cancel | canvas；`{id}` | `{ok:true}`；仅结束未接受上传，已接受导入不受影响 |
| GET / HEAD media | canvas、id；download可选；variant=original/preview/waveform、v=1可选 | original / preview为307到对应方法签名URL；waveform为200同源JSON，HEAD无正文；均no-store |
| GET / POST storage | POST StorageInput：requestId、revision、id?、type=aliyun-oss、name、region、bucket、endpoint、prefix、accessKeyId?、accessKeySecret? | ObjectStorageSettings：configured、activeProviderId、revision、providers、moving、failed；AK仅掩码 |
| POST storage-test | 同StorageInput，仅测试不切换 | `{ok:true}` |
| POST media-urls | canvas；items 1–100个 `{assetId,variant?}`、force默认false | `{items:[{assetId,variant,url,expiresAt}或{assetId,variant,error}]}`；逐项隔离失败 |
| POST storage-retry | 无 | `{ok:true}`，失败清单重新排队 |

共29个注册路径（28个v2路径和旧workspace GET）。旧 `/api/canvas/workspace`仅GET投影保留，旧mutation不写入；服务内legacy models alias保留，Harness仅注册新models。旧JSON / 媒体不扫描、不导入。

常规Key掩码采用头3 / 星号8 / 尾3，长度≤6全遮，不返回原Key；storage provider新增可选accessKeySecretMask。EP字段保持原模型配置格式并在UI默认遮罩。显式settings-secret响应只含当前单字段，客户端不持久化 / 不放入保存草稿，取消与隐藏拒绝迟到结果；参见[ADR-0058](adr/0058-masked-settings-and-explicit-secret-reveal.md)。

Mock模型来自[固定共享定义](../src/shared/mockModels.ts)，不写入models.json，不需要凭据。任务快照仍是严格ModelRecord，只有身份 / 名称 / 协议 / 地址全部匹配内置记录时才允许无凭据本地执行。mock-generate的幂等hash包含mock:true，与generate不可共用requestId。输出ID由任务ID和序号确定，写入同一task_outputs / canvas_assets，复用既有尺寸 / 时长字段；不新增表、节点、边或持久任务DTO字段。0.2.11的主图默认端点规则仍用于单次批量，0.2.44多次提交展开时派生逐素材端点；展开状态不进入增量DTO，旧边assetId保持。

上传为streaming，默认4MiB分块，按实际字节、SHA-256及最终格式检查，不以MIME / 声明长度跳过检查。独立staging/<UUID>.resume.json记录size、offset、块hash与文件身份，fsync字节后原子提交日志；不修改两库DDL。中断 / 5xx / 不明回执先GET进度再重试，旧无size上传不支持续传。202表示导入任务持久接受，不代表OSS保存成功；见[ADR-0063](adr/0063-resumable-uploads-and-progress-capsules.md)。0.2.65浏览器共享管理器最多五个并发流程，前五枚与其余+N仅为Client投影；不改变HTTP契约或后台OSS导入并发，见[ADR-0064](adr/0064-bounded-upload-capsules-and-five-transfers.md)。

media-urls校验当前画布素材归属，不接受任意key。Host缓存最多2048项，签名方法 / 用途 / 版本 / 凭据纳入身份；默认GET 3600秒，剩余不足300秒刷新；force绕开缓存。graph读取不签名，JSON与307均no-store。HEAD独立签名；下载携带UTF-8 Content-Disposition签名参数。OSS应配置私有Bucket、CORS GET / HEAD和Range所需头；真实响应行为需用户验收。

preview仅图片 / 视频，image/webp；waveform仅音频，JSON为 `{version:1,duration:实际解码秒数,peaks:96项0–1幅度}`。独立串行解码队列最多32身份，30秒失败冷却，临时解码后发布OSS并登记asset_variants；失败不影响原文件 / 付费任务。waveform通过认证Host读取云端JSON，校验bytes / SHA / schema，最多8192字节；内存2048项 / 1小时TTL，同身份合并，32不同身份读取上限、128项失败 / 30秒冷却。GET / HEAD为200、Content-Type / Length、nosniff且no-store，HEAD无正文；不要求浏览器fetch跨域OSS。见[ADR-0045](adr/0045-same-origin-waveforms-and-ratio-order.md)，算法仍见[ADR-0028](adr/0028-audio-waveforms-and-compact-prompts.md)。

## 文件与凭据布局

```text
dataDir/
  canvas.sqlite                 结构数据（运行时可能有 -wal / -shm）
  .writer/pid                  与旧版协调
  models.json                  公开模型配置
  model-bindings.json          modelId → credentialRef
  tts-settings.json            FishTTS endpoint / revision / service ID / credentialRef，无Key
  vault/                       仅开发 LocalVault 明文版本文件
  staging/                     未完成上传 / 输出恢复暂存，成功清理
系统临时目录/dsh-canvas-decode-*/   解码临时文件，完成清理
私有OSS/
  prefix/文件夹名称__ID/画布名称__ID/资源名称__ID.ext
  prefix/未归档/画布名称__ID/_derived/assetId/preview或waveform-v1-hash.webp|json
```

新建目录0700、文件0600。Harness Key 存于 ctx.credentials 提供方，备份须同时备份其持久记录；dataDir 单独复制不包含这些 Key。模型配置仍 JSON，凭据与 SQL 不跨介质原子。

## 主要错误

0.2.47只改变客户端不可变快照的内存共享：按ID与全部JSON字段复用相同记录，保留顺序并识别字段移除。图修订未变仍检测任务 / 资产变化；冲突时草稿保持。位置 / 内容隔离、只读显示投影和实时图写入见[ADR-0052](adr/0052-position-and-content-render-isolation.md)。HTTP、CanvasGraph、SQLite DDL与已有hash / receipt语义保持。

错误 JSON `{error,code}` 脱敏并不缓存；认证层另行处理。常用：400 INVALID_REQUEST；404 NOT_FOUND / MODEL_NOT_FOUND / MEDIA_MISSING；409 GRAPH_CONFLICT / HASH_MISMATCH / REQUEST_REUSED / CATALOG_CONFLICT / STORAGE_CONFLICT / NAME_EXISTS / FOLDER_NOT_EMPTY / NODE_BUSY / CANVAS_BUSY / TASK_CREDENTIALS_MISSING / UNSAFE_PATH / SNAPSHOT_REQUIRED / MEDIA_CHANGED；413 MEDIA_TOO_LARGE；415 UNSUPPORTED_MEDIA；422或503 PREVIEW_UNAVAILABLE / WAVEFORM_UNAVAILABLE（原文件仍走原接口）；429 QUEUE_FULL；503 WRITER_FENCED。

存储常用错误：409 STORAGE_NOT_CONFIGURED / STORAGE_CONFLICT / STORAGE_CREDENTIALS_MISSING / OBJECT_CHANGED / STAGING_CHANGED；502 STORAGE_UNAVAILABLE / STORAGE_PROBE_FAILED；422 VARIANT_UNAVAILABLE。旧schema与STORE_LOCKED属启动失败。普通OS / SQL异常可能使用400通用错误；owner范围为整个实例，当前无多用户ACL / 跨设备同步。
