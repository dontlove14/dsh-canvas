# 开发交付规则

文档类型：操作指南；负责人：项目维护者 / 开发执行者；最近核对：2026-11-12。

本文件供后续开发执行者进入仓库时读取。完整规则以 [ADR-0021](docs/adr/0021-local-update-and-package-retention.md) 为准，具体操作见[运行指南](docs/operations.md)。每轮修改完成时核对；目标环境、检查或保留规则变化时同步更新。

- Fish音色按[ADR-0091](docs/adr/0091-fish-voice-discovery-cloning-and-chat-auditions.md)：voice子级核验官网候选，主级协调用户选择；无可用ID或官网无法访问时，主级指引用户在可访问设备选音色、从详情地址`/m/`后复制ID发回对话，收到用户ID不再次查找或要求官网核验。试听以真实ID通过原TTS队列合成，对话播放器只读原任务且不自动播放/重生成。复刻只接受一份音频边，与ID互斥，reference_text为参考原文、prompt为新朗读文字；TTS不插媒体token。旧“不接受TTS输入”规则由0091替代，图/DDL保持。

- 每轮修改完成且必要检查通过后，主动完成版本更新、构建、打包、本地插件安装、Harness 重启和加载核验，再交付给用户；不要停在“源码已修改”或让用户重复手动安装。
- 当前已授权目标为本机 Harness `web` profile、`http://127.0.0.1:3080`。沿用既有配置，不重复初始化 profile；默认不操作5173开发实例。
- Agent分工按[ADR-0086](docs/adr/0086-creative-projects-and-scoped-canvas-executor.md)：主级统筹/用户决定，专业子级读取资料与保存成果，同级canvas-executor为Agent节点写入口，宿主持有精确清单、根身份、CAS/epoch、幂等与任务；不把小说改编固化成专用管线。原文与成果使用独立sidecar，保持存量CanvasGraph/DDL。
- 成果交接按[ADR-0088](docs/adr/0088-saved-artifact-handoff-and-independent-identity.md)：批次taskId与新成果artifactId分开，已保存成果按实际回执核验并复用；旧全文结果先匹配本批次成果，未匹配才另存独立ID。不得重新渲染已保存文件、重置认可或改写历史混用ID；长标题须保留完整UUID和扩展名。
- Agent参考准备按[ADR-0089](docs/adr/0089-agent-reference-generation-and-prompt-mentions.md)：有素材的视频优先参考生成；create/update通过references与prompt的`{{asset:UUID}}`同次保存真实边和@标签，逐项说明用途。首尾帧参数不代替连线；交接核对完整参数与实际引用，不自动修补历史图或重提生成。
- 视频一致性按[ADR-0090](docs/adr/0090-model-aware-video-consistency-references.md)：以所选模型referenceLimits按镜头规划分镜/人物/场景/道具/适用音色；不支持音频则跳过音色。参考生视频核对派生素材当时的原始依赖，必要原图直接连入；无关依赖仅按主级精确排除原因和交接回执处理，不猜用途或自动连线。
- 可视化展示Agent运行与协作状态的功能正式命名为“Agent 空间”，命名与只读对接按[ADR-0093](docs/adr/0093-agent-space-name-and-integration-boundaries.md)，日志按[ADR-0087](docs/adr/0087-visible-agent-collaboration-journal.md)。界面按[ADR-0100](docs/adr/0100-agent-space-upper-left-card-and-working-podiums.md)：对话左上真正悬浮，无独立白框；展开/缩小按钮右上跨边，不占内容；发送默认展开，缩小展示实际工作Agent的正面站台，无工作者时主级单人正面待机；正常最终回复自动缩小，不显示任务文字/摘要；替换旧入口及气泡，不新开协作页签。0.2.140移除整行和左侧分栏占位，尺寸及展开标记只写自建absolute seat，保持原生正文/输入框完整宽高、class/style/dataset、scroll直接子级、宽度偏好和控制柄，不增加测量或改上游。延续已认可9项正面原片及透明循环，M09待机1.0倍、M10与专业09工作；旧播放中断不隐藏已恢复视频，后台/不可见/减少动态仍暂停。选择预设先确认，确认后Solving与“资源加载中”真实百分比，取消恢复原选项/默认项。沿已授权web / 3080检查、安装和重启，成功前保留0.2.139回退。卡片共享root只读日志，公开过程/实际回执/主级接续/用户认可分开；观察/重连/恢复不得执行、夺权、改图，不捕获隐藏思维/原文/凭据，派生activity不持久化，正式命名不迁移机器键/存量数据。
- 版本、包内文件和实际安装内容必须匹配；检查失败先修复，不安装失败候选。使用现有 `npm run check` 和产物核验管线。
- 缩小空集合延续0.2.139：主级单人M09正面待机1.0倍、working=false；停止/异常/未知不改为成功完成，展开原失败动作与恢复后实际工作者保持，原素材不重新处理。
- 长时媒体恢复按[ADR-0095](docs/adr/0095-long-lived-media-url-recovery.md)：失败组件保留共享订阅，按可见资源换签；每轮一次强制刷新，确认加载成功或页面 / 网络 / 视口恢复后开放新轮次。换签保留旧图和播放状态，内部revision不持久化。
- 可见性按[ADR-0096](docs/adr/0096-latest-element-visibility-notifications.md)统一使用observeVisibility，取当前元素时间最新的通知，忽略旧批次 / 已清理回调；保持各入口rootMargin与暂停策略，不新增布局测量或改固定上游源码。
- 堆叠尺寸按[ADR-0097](docs/adr/0097-stack-size-from-top-media.md)跟随最上层媒体，按节点 / assetId共享临时解码尺寸，节点边界和历史编辑锚点同步；不写回素材、图或任务，不按历史最大尺寸缩放当前首图。
- Agent 空间办公室动作按[ADR-0098](docs/adr/0098-agent-space-motion-and-preparation.md)，倍速按[ADR-0099](docs/adr/0099-agent-space-per-action-playback-rates.md)：待机1.0倍，M08主级招呼1.2倍，V07视觉资产右行走与R07审查右行走先1.6倍，其余动作1.8倍；对应移动速度与视频时间同步换算，转身不继承步态例外。全部素材与首帧提前准备后同步播放；闲置/失败/待认可使用对应动态循环，专业交接真实走近、转身、手心递交并返回，主级回原位恢复右向。缺动作不以静态平移、镜像或远距飞文件代替；38条补充原片统一一批交接，素材在agent_team/motions。独立Demo保留，插件候选仅按真实root→child / child→root公开链路展示，不猜专业间交接。
- 更新前备份 profile 配置，仅正常停止已核实的目标进程。保持画布、媒体、模型、凭据与任务身份；不得扩大为清空数据或重新提交生成任务。
- 每轮更新成功后，根目录只保留最新已安装且已核验的 `dsh-canvas-<version>.tgz`。新版本核验成功前保留上一可用包用于失败回退，成功后清理过期包。
- 临时脚本、日志、调试回执和备份放工作区外的受限临时目录；不得输出认证链接或密钥。源码与必要产物身份清单留在项目中。
- 浏览器视觉和交互由用户手动验收；自动化检查和HTTP加载核验不能代替人工结果。
- 画布文字默认禁止选中；原生输入框自动开放，自定义复制区域使用 `data-dc-text-selectable="true"`，新增画布portal接入公共作用域。按 [ADR-0060](docs/adr/0060-canvas-text-selection-opt-in.md)维护，不逐组件补禁选，不关闭节点框选。
- 新增可创建节点类型须维护统一 `CREATABLE_NODES` 注册与工厂，同时核对底部添加栏、空白右键菜单、输出端点拉到空白的菜单；默认参数、模型输入校验、渲染 / 编辑及三个入口专项一并维护。按 [ADR-0066](docs/adr/0066-shared-node-creation-entrances.md)执行，拉线创建节点与引用边必须同次保存。
- 新增或替换插件 Loading 前，按 [ADR-0046](docs/adr/0046-dependency-backed-whole-node-loading.md) 询问用户选型；用户已明确指定时不重复询问。任务使用 Thinking Orbs / Beam，媒体文件加载按 [ADR-0061](docs/adr/0061-dependency-backed-media-pixel-loading.md) 使用 ImageGeneration；固定源码 / 许可 / 哈希和按效果着色器修复按 [ADR-0094](docs/adr/0094-fixed-img-fx-source-and-specialized-media-shaders.md)，直接使用上游并跟随 Harness 主题，以不同样式表示阶段，不显示状态文字。
