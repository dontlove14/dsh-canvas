# ADR 决策记录

文档类型：解释；负责人：项目维护者；最近核对：2026-10-27。发布时复核有效性；决策替换或重审条件出现时立即更新，规则见[文档导航](../index.md)。

0001–0012 保留首版补录；0013–0017 记录 SQLite / 目录 / 媒体 / Runtime 实施，0018 补充项目列表与编辑器导航，0019 记录原生设置样式与宿主主题继承，0020 记录通用组件规则，0021 记录每轮自动更新本地插件和压缩包清理。被取代的实现标为“已替代”，仍有效的原则在原 ADR 增加更新说明。2026-10-26 为本次实施 / 核对日期。

用户指定的 `documentation-and-adrs` skill 未在本地及技能市场找到。本次采用已安装 staff-engineer-mode 的 `documentation-lifecycle` 与 `architecture-decisions` 专项规范：区分教程 / 操作 / 参考 / 解释，记录权威来源、负责人、复核触发条件；ADR 保留背景驱动、明确决定、备选方案、正负后果、可逆性与证据。

## 索引

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
| [ADR-0015](0015-named-media-and-durable-moves.md) | 按名称媒体与可恢复搬移 | Host 路径、发布、复制 / CAS、历史保留 | 已采纳 |
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

## 如何使用

ADR 回答为什么，不替代当前[业务规则](../business.md)、[架构](../architecture.md)、[数据与接口](../data-api.md)、[模型协议](../providers.md)或[操作指南](../operations.md)。这些参考文档维护当前精确参数和行为，ADR 引用它们。

改变已采纳决定时新建连续编号记录，并把旧记录标为已替代、双向关联。未实施的新决定标为提议；验证证据不足不能写成通过。可逆性说明是重审依据，不构成未来开发承诺。
