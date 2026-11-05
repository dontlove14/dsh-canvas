# 开发交付规则

文档类型：操作指南；负责人：项目维护者 / 开发执行者；最近核对：2026-11-05。

本文件供后续开发执行者进入仓库时读取。完整规则以 [ADR-0021](docs/adr/0021-local-update-and-package-retention.md) 为准，具体操作见[运行指南](docs/operations.md)。每轮修改完成时核对；目标环境、检查或保留规则变化时同步更新。

- Fish音色按[ADR-0091](docs/adr/0091-fish-voice-discovery-cloning-and-chat-auditions.md)：voice子级核验官网候选，主级协调用户选择；无可用ID或官网无法访问时，主级指引用户在可访问设备选音色、从详情地址`/m/`后复制ID发回对话，收到用户ID不再次查找或要求官网核验。试听以真实ID通过原TTS队列合成，对话播放器只读原任务且不自动播放/重生成。复刻只接受一份音频边，与ID互斥，reference_text为参考原文、prompt为新朗读文字；TTS不插媒体token。旧“不接受TTS输入”规则由0091替代，图/DDL保持。

- 每轮修改完成且必要检查通过后，主动完成版本更新、构建、打包、本地插件安装、Harness 重启和加载核验，再交付给用户；不要停在“源码已修改”或让用户重复手动安装。
- 当前已授权目标为本机 Harness `web` profile、`http://127.0.0.1:3080`。沿用既有配置，不重复初始化 profile；默认不操作5173开发实例。
- Agent分工按[ADR-0086](docs/adr/0086-creative-projects-and-scoped-canvas-executor.md)：主级统筹/用户决定，专业子级读取资料与保存成果，同级canvas-executor为Agent节点写入口，宿主持有精确清单、根身份、CAS/epoch、幂等与任务；不把小说改编固化成专用管线。原文与成果使用独立sidecar，保持存量CanvasGraph/DDL。
- 成果交接按[ADR-0088](docs/adr/0088-saved-artifact-handoff-and-independent-identity.md)：批次taskId与新成果artifactId分开，已保存成果按实际回执核验并复用；旧全文结果先匹配本批次成果，未匹配才另存独立ID。不得重新渲染已保存文件、重置认可或改写历史混用ID；长标题须保留完整UUID和扩展名。
- Agent参考准备按[ADR-0089](docs/adr/0089-agent-reference-generation-and-prompt-mentions.md)：有素材的视频优先参考生成；create/update通过references与prompt的`{{asset:UUID}}`同次保存真实边和@标签，逐项说明用途。首尾帧参数不代替连线；交接核对完整参数与实际引用，不自动修补历史图或重提生成。
- 视频一致性按[ADR-0090](docs/adr/0090-model-aware-video-consistency-references.md)：以所选模型referenceLimits按镜头规划分镜/人物/场景/道具/适用音色；不支持音频则跳过音色。参考生视频核对派生素材当时的原始依赖，必要原图直接连入；无关依赖仅按主级精确排除原因和交接回执处理，不猜用途或自动连线。
- 协作监控按[ADR-0087](docs/adr/0087-visible-agent-collaboration-journal.md)与[ADR-0092](docs/adr/0092-floating-agent-collaboration-network.md)：卡片与输入框上方右侧可缩小浮层共享root只读日志，不新开协作页签；缩小用Voice Ring，展开按实际会话圆点/曲线与方向显示。公开过程、实际回执、主级接续与用户认可分开；观察/重连/恢复不得执行、夺权或改图，不捕获隐藏思维/原文/凭据，派生activity不持久化。
- 版本、包内文件和实际安装内容必须匹配；检查失败先修复，不安装失败候选。使用现有 `npm run check` 和产物核验管线。
- 更新前备份 profile 配置，仅正常停止已核实的目标进程。保持画布、媒体、模型、凭据与任务身份；不得扩大为清空数据或重新提交生成任务。
- 每轮更新成功后，根目录只保留最新已安装且已核验的 `dsh-canvas-<version>.tgz`。新版本核验成功前保留上一可用包用于失败回退，成功后清理过期包。
- 临时脚本、日志、调试回执和备份放工作区外的受限临时目录；不得输出认证链接或密钥。源码与必要产物身份清单留在项目中。
- 浏览器视觉和交互由用户手动验收；自动化检查和HTTP加载核验不能代替人工结果。
- 画布文字默认禁止选中；原生输入框自动开放，自定义复制区域使用 `data-dc-text-selectable="true"`，新增画布portal接入公共作用域。按 [ADR-0060](docs/adr/0060-canvas-text-selection-opt-in.md)维护，不逐组件补禁选，不关闭节点框选。
- 新增可创建节点类型须维护统一 `CREATABLE_NODES` 注册与工厂，同时核对底部添加栏、空白右键菜单、输出端点拉到空白的菜单；默认参数、模型输入校验、渲染 / 编辑及三个入口专项一并维护。按 [ADR-0066](docs/adr/0066-shared-node-creation-entrances.md)执行，拉线创建节点与引用边必须同次保存。
- 新增或替换插件 Loading 前，按 [ADR-0046](docs/adr/0046-dependency-backed-whole-node-loading.md) 询问用户选型；用户已明确指定时不重复询问。任务使用 Thinking Orbs / Beam，媒体文件加载按 [ADR-0061](docs/adr/0061-dependency-backed-media-pixel-loading.md) 使用 ImageGeneration；直接使用依赖并跟随 Harness 主题，以不同样式表示阶段，不显示状态文字。
