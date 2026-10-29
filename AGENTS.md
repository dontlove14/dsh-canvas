# 开发交付规则

文档类型：操作指南；负责人：项目维护者 / 开发执行者；最近核对：2026-10-29。

本文件供后续开发执行者进入仓库时读取。完整规则以 [ADR-0021](docs/adr/0021-local-update-and-package-retention.md) 为准，具体操作见[运行指南](docs/operations.md)。每轮修改完成时核对；目标环境、检查或保留规则变化时同步更新。

- 每轮修改完成且必要检查通过后，主动完成版本更新、构建、打包、本地插件安装、Harness 重启和加载核验，再交付给用户；不要停在“源码已修改”或让用户重复手动安装。
- 当前已授权目标为本机 Harness `web` profile、`http://127.0.0.1:3080`。沿用既有配置，不重复初始化 profile；默认不操作5173开发实例。
- 版本、包内文件和实际安装内容必须匹配；检查失败先修复，不安装失败候选。使用现有 `npm run check` 和产物核验管线。
- 更新前备份 profile 配置，仅正常停止已核实的目标进程。保持画布、媒体、模型、凭据与任务身份；不得扩大为清空数据或重新提交生成任务。
- 每轮更新成功后，根目录只保留最新已安装且已核验的 `dsh-canvas-<version>.tgz`。新版本核验成功前保留上一可用包用于失败回退，成功后清理过期包。
- 临时脚本、日志、调试回执和备份放工作区外的受限临时目录；不得输出认证链接或密钥。源码与必要产物身份清单留在项目中。
- 浏览器视觉和交互由用户手动验收；自动化检查和HTTP加载核验不能代替人工结果。
- 画布文字默认禁止选中；原生输入框自动开放，自定义复制区域使用 `data-dc-text-selectable="true"`，新增画布portal接入公共作用域。按 [ADR-0060](docs/adr/0060-canvas-text-selection-opt-in.md)维护，不逐组件补禁选，不关闭节点框选。
- 新增可创建节点类型须维护统一 `CREATABLE_NODES` 注册与工厂，同时核对底部添加栏、空白右键菜单、输出端点拉到空白的菜单；默认参数、模型输入校验、渲染 / 编辑及三个入口专项一并维护。按 [ADR-0066](docs/adr/0066-shared-node-creation-entrances.md)执行，拉线创建节点与引用边必须同次保存。
- 新增或替换插件 Loading 前，按 [ADR-0046](docs/adr/0046-dependency-backed-whole-node-loading.md) 询问用户选型；用户已明确指定时不重复询问。任务使用 Thinking Orbs / Beam，媒体文件加载按 [ADR-0061](docs/adr/0061-dependency-backed-media-pixel-loading.md) 使用 ImageGeneration；直接使用依赖并跟随 Harness 主题，以不同样式表示阶段，不显示状态文字。
