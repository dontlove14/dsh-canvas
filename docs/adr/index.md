# ADR 决策记录

文档类型：解释；负责人：项目维护者；最近核对：2026-10-30。发布时复核有效性；决策替换或重审条件出现时立即更新，规则见[文档导航](../index.md)。

0001–0012 保留首版补录；0013–0017 记录 SQLite / 目录 / 媒体 / Runtime 实施，0018 补充项目列表与编辑器导航，0019 记录原生设置样式与宿主主题继承，0020 记录通用组件规则，0021 记录每轮自动更新本地插件和压缩包清理。被取代的实现标为“已替代”，仍有效的原则在原 ADR 增加更新说明。2026-10-26 为本次实施 / 核对日期。

用户指定的 `documentation-and-adrs` skill 未在本地及技能市场找到。本次采用已安装 staff-engineer-mode 的 `documentation-lifecycle` 与 `architecture-decisions` 专项规范：区分教程 / 操作 / 参考 / 解释，记录权威来源、负责人、复核触发条件；ADR 保留背景驱动、明确决定、备选方案、正负后果、可逆性与证据。

## 索引

Wan / H3 四渠道、原生协议与共用视频行为见 [ADR-0067](0067-wan-and-minimax-native-video-protocols.md)。

| 编号 | 决策 | 覆盖范围 | 状态 |
| --- | --- | --- | --- |
| [ADR-0001](0001-harness-plugin-boundaries.md) | 使用 Harness 公开扩展边界与 owner 认证 | 插槽、工作区、宿主 / 浏览器、开发载体 | 已采纳（补录） |
| [ADR-0002](0002-node-types-and-provider-capabilities.md) | 五种节点、协议能力与逐节点执行 | 业务范围、模型配置、适配器边界 | 已采纳（补录） |
| [ADR-0003](0003-local-single-writer-store.md) | 本地单写者文件存储与版本化契约 | 历史 JSON 实现 | 已替代，0013 |
| [ADR-0004](0004-host-owned-credentials.md) | 宿主持有密钥与任务凭据快照 | 历史文件凭据 | 已替代，0016 |
| [ADR-0005](0005-immutable-asset-references.md) | 连线绑定具体素材，预览独立 | 引用校验、重生成、资源重新导入 | 已采纳（补录） |
| [ADR-0006](0006-durable-task-recovery.md) | 持久任务恢复与未知提交不重提 | 历史私有文件恢复 | 已替代，0016 |
| [ADR-0007](0007-autosave-and-revision-conflicts.md) | 自动保存与乐观修订冲突 | 历史全图保存 | 已替代，0013 |
| [ADR-0008](0008-streamed-local-media.md) | 媒体复制、限额流保存与按需播放 | 历史 UUID 文件布局 | 已替代，0015 |
| [ADR-0009](0009-shared-react-and-lazy-browser-build.md) | 共享 React 与 Harness lazy 浏览器构建 | 双入口、私有 React Flow、JSX | 已采纳（补录） |
| [ADR-0010](0010-conditional-gpu-compositing.md) | 保守检测后的视口 GPU 合成提示 | 硬件检测、回退、隐私、性能边界 | 已采纳（补录） |
| [ADR-0011](0011-polling-and-operation-concurrency.md) | 宿主调度、状态轮询与操作并发 | 历史内存 due 实现 | 已替代，0016 |
| [ADR-0012](0012-retained-media-and-result-batches.md) | 保留媒体历史与最新可用批次展示 | 删除、结果选择、部分保存、GC 边界 | 已采纳（补录） |
| [ADR-0013](0013-sqlite-deltas-and-migration.md) | SQLite 增量事务、hash 链与只读旧源迁移 | 21 表 / 39 显式索引、CAS、回执、迁移 | 已采纳 |
| [ADR-0014](0014-canvas-catalog-and-upload-nodes.md) | 自有画布目录与上传自动资源节点 | 一级文件夹、目录 CRUD、自动占位 / 导入 | 已采纳 |
| [ADR-0015](0015-named-media-and-durable-moves.md) | 按名称媒体与可恢复搬移 | 本地实现由0043替代，命名 / 清单 / CAS原则保留 | 已替代 |
| [ADR-0016](0016-host-runtime-task-details-and-credentials.md) | 宿主持久队列、任务两表与凭据版本 | 外部 ID、成功 / 失败、恢复、生命周期 | 已采纳 |
| [ADR-0017](0017-harness-official-cases-and-badcases.md) | Harness 官方契约 case / badcase | 官方三页、固定源码 / SDK、反例与检查 | 已采纳 |
| [ADR-0018](0018-project-list-before-canvas-editor.md) | 项目列表先行与独立画布编辑器 | 列表入口、上下文管理、保存后返回、页面任务边界 | 已采纳 |
| [ADR-0019](0019-harness-settings-and-theme-inheritance.md) | 原生设置样式与宿主主题继承 | 设置名称、卡片 / 表单、全插件语义色、开发兜底 | 已采纳 |
| [ADR-0020](0020-harness-shared-ui-primitives.md) | 优先复用 Harness 通用组件 | 官方组件、单选组合、多行输入、菜单 / 弹窗、共享构建与开发兜底 | 已采纳 |
| [ADR-0021](0021-local-update-and-package-retention.md) | 每轮开发自动更新本地插件与压缩包清理 | 检查 / 打包 / 安装 / 重启 / 核验、既有授权、只留最新包、失败回退 | 已采纳 |
| [ADR-0022](0022-media-covers-and-curved-edges.md) | 纯媒体节点、独立压缩封面与曲线连线 | 按需封面、第一帧、原媒体、浮动名称 / 操作栏、临时旋转 / 按需播放、兼容存量 | 已采纳 |
| [ADR-0023](0023-canvas-wheel-and-trackpad-gestures.md) | 滚轮 / 触控板平移与修饰键缩放 | 左键框选、空格拖拽、双轴滚动、Command / Ctrl、控件滚动边界 | 已采纳 |
| [ADR-0024](0024-custom-video-and-chromeless-preview.md) | 自定义有声视频控制与无外框媒体预览 | 单行控制条、进度 / 时间、固定声音、原比例展示、官方headless弹窗、焦点 / 关闭生命周期 | 已采纳 |
| [ADR-0025](0025-generation-groups-and-local-mock.md) | 简洁生成节点、多结果分组与本地Mock | 动态参数、主图 / 展开 / 具体素材连线、本地无Key渲染、现有任务 / 媒体恢复 | 已采纳 |
| [ADR-0026](0026-primary-only-group-interaction.md) | 媒体生成节点与主图专属分组交互 | 无父外框、矢量圆端点、只主图连接、展开隐藏编辑、固定左下收起、旧引用保留 | 已采纳 |
| [ADR-0027](0027-prompt-asset-mentions.md) | 图片 / 视频提示词的稳定素材引用 | @搜索、缩略图标签、合法自动连线、UUID兼容存储、任务编号解析、输入法 / 光标 / 撤销 | 已采纳 |
| [ADR-0028](0028-audio-waveforms-and-compact-prompts.md) | 真实音频波形节点与紧凑提示词卡片 | 流式幅度 / 派生缓存、自定义定位播放、按内容增高、徽章基线、控制行收尾 | 已采纳 |
| [ADR-0029](0029-generation-sliders-and-audio-wheel.md) | 通用参数滑块与音频滚动透传 | 1–10数量、固定 / 区间时长、原生受控组件、合法档位 / 键盘、存量兼容与音频平移 | 已采纳 |
| [ADR-0030](0030-fish-tts-nodes-and-streamed-audio.md) | FishTTS语音节点与限额音频流 | 无输入 / 模型、情绪标签、计数器、全局凭据、原任务保存 / 恢复、不改DDL的存储编码 | 已采纳 |
| [ADR-0031](0031-tts-emotion-badges-and-monochrome-nodes.md) | TTS情绪文字徽章与统一单色空态 | 共用编辑器、中文名 / 原值、剪贴板 / 撤销、portal、仅图标 / 仅输出、存量保持 | 已采纳 |
| [ADR-0032](0032-scale-aware-viewport-compositing.md) | 缩放时释放缓存合成层 | 硬件条件 / 平移短暂提示、缩放 / 静止释放、Store订阅、无逐帧重绘 / 媒体重挂载、矢量图标 | 已采纳 |
| [ADR-0033](0033-strict-marquee-selection.md) | 透明框选与严格几何选择 | 未测量候选过滤、完整包含 / 缩小 / 松手 / Shift、取消清理、Portal与结果操作隔离、无持久格式变化 | 已采纳 |
| [ADR-0034](0034-conversation-sidebar-canvas.md) | 对话右侧标签页画布 | 开始页入口、公开两阶段注册、保留草稿 / 隐藏暂停、容器响应式、共享API与原数据 | 已采纳 |
| [ADR-0035](0035-searchable-paginated-task-dialog.md) | 任务目录分页查询 | owner范围、联合条件、序号上限、通用双月时间 / 分页、目录表格与详情返回、旧数据兼容 | 已采纳 |
| [ADR-0036](0036-selected-node-relationship-flow.md) | 单选节点上下游连线流光 | 直接入出边、输出到输入、CSS亮段、隐藏暂停 / 静态降级、原数据与交互保持 | 已采纳 |
| [ADR-0037](0037-fixed-provider-image-models.md) | 固定供应商与图片参数映射 | 双供应商独立凭据、真实图片任务、有效尺寸表、部分失败保留 | 已采纳 |
| [ADR-0038](0038-model-configuration-summary-and-tts-header.md) | 配置概览与TTS s1 Header | 已配置模型汇总、先模型后供应商、密钥隔离、固定情绪版本 | 已采纳 |
| [ADR-0039](0039-configured-only-canvas-model-picker.md) | 画布只选有配置的真实模型 | 已由0040收紧为组合级筛选，空态与历史约束保留 | 已替代 |
| [ADR-0040](0040-configured-provider-combinations-only.md) | 只展示已配置模型供应商组合 | 未配置渠道隐藏、先过滤后分组、无自动换渠道、完整配置目录保留 | 已采纳 |
| [ADR-0041](0041-tts-configuration-readiness.md) | TTS节点配置提示与资格校验 | 独立Key读取、加载 / 缺配置提示、新任务拦截、原任务凭据保留 | 已采纳 |
| [ADR-0042](0042-node-anchored-overlays.md) | 节点附件自然锚定与层级 | 不按窗口挪动卡片，节点附件低于固定操作栏，视图状态不持久化 | 已采纳 |
| [ADR-0043](0043-object-storage-and-expiring-media-access.md) | 对象存储与临时媒体访问 | 单写入目标、定位持久化、过期刷新、云端恢复、限定历史清理 | 波形读取由0045更新，其余已采纳 |
| [ADR-0044](0044-wide-image-ratios-at-one-k.md) | 图片1K宽屏比例 | 三个合法预设、21:9标签、切档保持、旧尺寸与任务保留 | 已采纳，显示顺序由0045补充 |
| [ADR-0045](0045-same-origin-waveforms-and-ratio-order.md) | 同源波形与比例排序 | 认证JSON / 有界缓存，成对数值顺序到21:9，旧尺寸保持 | 已采纳 |
| [ADR-0046](0046-dependency-backed-whole-node-loading.md) | 整节点Loading依赖 | 全节点Beam / Orb，宿主主题与暂停，后续Loading选型询问 | 已采纳 |
| [ADR-0047](0047-zoom-aware-loading-resolution.md) | 缩放下的Loading分辨率 | 依赖密度补丁、整数档位、实际Store / DPR、原动画与媒体保持 | 已采纳 |
| [ADR-0048](0048-banana-native-image-protocol.md) | Nano Banana原生图片协议 | 四模型双渠道、Header隔离、Base64与实际尺寸、复用OSS结果恢复 | Model Link由0049修正，其余已采纳 |
| [ADR-0049](0049-modellink-banana-generate-content.md) | Model Link使用generateContent | REST路径与JSON / 返回、独立协议、不回落重提、旧任务保留 | 已采纳 |
| [ADR-0050](0050-submission-history-and-expanded-result-ports.md) | 按提交堆叠历史与展开逐素材端点 | 立即卡片、同节点多任务、确切回执核对、独立Loading / 引用、仅索引升级 | 已采纳；多次提交替代0026 |
| [ADR-0051](0051-readonly-submission-inspection.md) | 展开只读记录与收起最新编辑 | 持久快照、迟到读取取消、无写入查看、最新输入恢复、原引用身份 | 已采纳；替代0050展开编辑条款 |
| [ADR-0052](0052-position-and-content-render-isolation.md) | 节点位置与内容更新隔离 | 全字段共享、所属节点投影、几何测量、编辑器实时图写入、不改持久格式 | 已采纳 |
| [ADR-0053](0053-seedream-endpoint-routing-and-model-identity.md) | Seedream 独立渠道、EP路由与显示身份 | doubao / dola六组合、官方EP / Model Link ID、固定快照、原生JSON与OSS | Lite ID / 无结果状态由0054替代 |
| [ADR-0054](0054-no-result-submission-failure-and-seedream-id-correction.md) | 无结果提交失败与Seedream ID更正 | 本地failed、不重提、红色感叹号、配置更正保留凭据 / 快照 | 已采纳；部分替代0046 / 0053 |
| [ADR-0055](0055-seedance-video-modes-and-independent-provider-routing.md) | Seedance模式与独立渠道 | 八型号十二组合、官方EP / Model Link ID、互斥模式 / 帧角色、混合参考与OSS | 手动文生选择由0056替代，其余已采纳 |
| [ADR-0056](0056-seedance-mode-inference-from-references.md) | 根据引用推导Seedance模式 | 空引用text、首连reference、frames仅手动、清空重置、边与模式一起保存 | 已采纳；部分替代0055 |
| [ADR-0057](0057-provider-cards-and-direct-model-editing.md) | 供应商卡片与直接编辑 | 同供应商跨协议分组、响应式卡片、逐组合Key / EP编辑、取消 / 失败 / 清除保护 | 已采纳；部分替代0040 |
| [ADR-0058](0058-masked-settings-and-explicit-secret-reveal.md) | 脱敏配置与显式查看 | 部分掩码、逐字段owner只读、眼睛显隐、预览不写草稿、取消与迟到保护 | 已采纳；部分替代0016 / 0057 |
| [ADR-0059](0059-seedance-asset-review-and-frozen-generation-references.md) | Seedance素材预审与固定生成引用 | 两家独立 / 脱敏、按画布建组、逐素材异步恢复、主图 / 历史标记、Active用Asset ID其余URL | 已采纳 |
| [ADR-0060](0060-canvas-text-selection-opt-in.md) | 画布文字默认禁选与显式开放 | 画布 / portal统一默认、原生输入 / 可编辑 / 复制区域开放、保留节点框选与原子标签 | 已采纳 |
| [ADR-0061](0061-dependency-backed-media-pixel-loading.md) | 媒体文件像素Loading | 真实ImageGeneration、Harness黑白主题、共享GPU / 暂停 / 静态兼容与隐藏署名 | 已采纳；媒体阶段部分替代0046 / 0047 |
| [ADR-0062](0062-harness-node-delete-confirmation.md) | Harness节点删除确认 | 原生Delete / Backspace、Modal / Button、异步取消与最新任务检查、保留媒体 / 下游结果 | 已采纳 |
| [ADR-0063](0063-resumable-uploads-and-progress-capsules.md) | 断点续传与进度胶囊 | 原UUID / Blob恢复、持久分块与幂等导入、顶部圆环叠放、多文件追加、保持两库结构 | 并发 / 展示由0064部分替代，其余已采纳 |
| [ADR-0064](0064-bounded-upload-capsules-and-five-transfers.md) | 五路上传与有界胶囊动效 | 五槽 / 五枚及+N、轻悬浮 / 真实Beam、主题 / 暂停、进入与连续完成补位 | 已采纳；部分替代0063 |
| [ADR-0065](0065-exclusive-canvas-file-drop.md) | 画布文件拖放与宿主附件互斥 | 可见区域 / 最终落点、window捕获、跨区蒙版清理、原文件唯一接收、隐藏与卸载 | 已采纳 |
| [ADR-0066](0066-shared-node-creation-entrances.md) | 统一节点创建与拉线快捷入口 | 共用注册 / 工厂、空白右键、固定输出引用、节点与边原子保存、扩展三入口维护 | 已采纳 |
| [ADR-0067](0067-wan-and-minimax-native-video-protocols.md) | Wan 3.0与MiniMax H3双渠道原生协议 | 四渠道 / 十二组合、共用模式与独立能力、固定OSS参考、原任务恢复、原结构保持 | 已采纳 |
| [ADR-0068](0068-selection-output-and-reference-interactions.md) | 临时分组选区输出与引用操作 | 原生端点 / 主体接线、批量校验与同次保存、仅下载、@边删除确认、平台快捷键 | 已采纳；补充0033 / 0062 / 0066 |
| [ADR-0069](0069-non-commercial-modellink-attribution-license.md) | 非商业使用与 Model Link 署名许可 | LICENSE / NOTICE、商业边界、可点击署名、第三方许可、分发包与身份清单 | 已采纳 |

## 如何使用

ADR 回答为什么，不替代当前[业务规则](../business.md)、[架构](../architecture.md)、[数据与接口](../data-api.md)、[模型协议](../providers.md)或[操作指南](../operations.md)。这些参考文档维护当前精确参数和行为，ADR 引用它们。

改变已采纳决定时新建连续编号记录，并把旧记录标为已替代、双向关联。未实施的新决定标为提议；验证证据不足不能写成通过。可逆性说明是重审依据，不构成未来开发承诺。
