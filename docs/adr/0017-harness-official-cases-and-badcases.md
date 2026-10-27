# ADR-0017：Harness 官方扩展契约的 case 与 badcase

状态：已采纳

文档类型：解释；负责人：项目维护者；最近核对：2026-10-26。
记录日期：2026-10-26。SDK / profile / 生命周期变化时重审；补充 [ADR-0001](0001-harness-plugin-boundaries.md)，实现落点见 ADR-0013 至 ADR-0016。

## 背景与驱动因素

1. 插件需要复用宿主公开边界，不能仅凭名称推断工作区、任务、存储或凭据能力。
2. 用户要求实现前核对官方参考、开发入门、快速开始，并长期保留正确用法和反例。
3. 在线 master 与安装 SDK 可能不同；文档事实、编译类型和本插件决定必须分开。

## 决策

资料核对日期 2026-10-26。官方网页：

- [Reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
- [Develop basic](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)
- [Quickstart](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)
- [插件 Config](https://deepseek-harness.github.io/deepseek-harness/develop/basic/config)
- [Cordis 配置教程](https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/05-config)

在线源代码基线为 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（2026-10-23）；实际编译 SDK 为 `0.2.1-rc.2`，不是声称使用 master。以下表中“选择”是本插件决策，不冒充官方功能保证。

| 场景 | 官方 / SDK 依据 | case：本插件选择 | badcase：需要避免 |
| --- | --- | --- | --- |
| 插件装配 | basic 的 apply / inject / ctx.effect | Host 声明 connection / credentials；effect 清理服务、路由 | 直接改 Harness 内核；只在 React unmount 停后台 |
| 插件启动配置 | basic/config、05-config 与 SDK `Plugin.Config?: StandardSchemaV1` | 导出 Zod 4 Config（实现 Standard Schema）及同名类型，声明 dataDir、并发、超时、媒体限额；加载前校验 / 填默认值 | 导出普通对象当验证器；把教程示例视为只允许 Schemastery；由 Config 声明推断已自动生成设置页面 |
| 插件设置页面 | SDK ui-settings 的 `settings.section` 类型与 README：设置外壳归宿主，页面由插件注册 | Client 注册 `canvas-models` / “无限画布 模型设置”，在 Harness 设置里复用 ModelSettings；独立开发页另保留画布设置弹窗；主题与样式见[ADR-0019](0019-harness-settings-and-theme-inheritance.md) | 只提供画布弹窗却宣称接入宿主设置；把开发页当 Harness 外壳；用 DOM 查找 / 点击宿主按钮替代公开接口 |
| owner HTTP | connection Fetch 公共 register | exact path、GET / POST / HEAD 白名单，复用 owner 认证 | 另开未经认证端口；把任意磁盘路径作为媒体查询 |
| 请求断开 | connection 的 handler signal 随 Peer / request 取消 | signal 仅控制接收字节；任务 COMMIT 后交 Runtime | 将 request.signal 传给整项生成，刷新就停止 |
| 后台存活 | 插件副作用随 context 卸载 | 关面板 / 浏览器继续，Host 停机后按 DB 恢复 | 承诺卸载后台插件、关机后本机代码仍执行 |
| 任务注册表 | [jobs-local README](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/jobs/jobs-local/README.zh.md)：内存、不排队、运行 / 输出不跨重启恢复 | 使用 SQLite 自有队列，不要求 jobs 注入 | 把 registry 当持久队列；容量拒绝理解为排队 |
| 任务所有权 | [jobs seam](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/jobs/jobs/README.zh.md)：Session / producer / controller 生命周期 | 画布任务使用 canvas / node / 本地 task ID | 随意挂 Agent Session；宿主 job ID 覆盖供应商 ID |
| 会话与画布 | quickstart 中 Workspace 的会话 / 文件语义 | 插件维护自己的一级文件夹和画布 | 把每张画布等同聊天 Workspace，顺带修改其目录 |
| storage | SDK storage 公共 KV 单次调用原子，顺序由调用方负责 | node:sqlite Worker 负责多表事务 | 多次 KV 调用称为图、边、任务两表原子事务 |
| credentials | SDK readRecord / modifyRecord 公共类型 | 插件自有 record，每次 Key 改动新版本，任务固定 ref | SQL 存明文 Key；固定名称 record 覆盖后声称旧任务有快照 |
| Host 选目录 | picker capability native / browse | 当前手动输入 Host 绝对路径；以后接入时按 capability 呈现 | 浏览器选本机目录等同远端 Host 目录；假设总有 OS 对话框 |
| 上传请求体 | connection 支持 streaming / buffered 声明 | 控制 JSON buffered，媒体原始字节 streaming | 大视频塞 Base64 JSON、全量 buffered handler |
| React 加载 | lazy client module 与共享依赖 | React / JSX runtime 共享，React Flow 私有打包 | 打包第二份 React，导致 hook / dispatcher 错误 |
| profile | quickstart 与 CLI profile 初始化规则 | 首次初始化，再 add 包、日常启动；测试 dataDir 单独配置 | 日常重复 --from-default-profile；不同 profile 假定插件 dataDir 自动不同 |
| Worker 构建 | Node import.meta.url 的实际位置 | 打包时 worker.mjs / schema.sql 置于 lib 根并核对包内容 | 源码测试通过却遗漏 Worker / schema，插件安装后无法启动 |

实际 API 签名核对以安装包声明为准：connection 的 `register({path,methods,requestBody,fetch})`，credentials 的 `readRecord / modifyRecord`，picker 的 `capability()` union。详见[架构提案的来源表](../proposals/canvas-plugin-architecture-v0.1.md)，其中 node_modules 链接仅供完整源码工作区核对。

2026-10-26 补充核对两页 Config 文档：配置 schema 与设置页面注册是两个接入点。当前模型列表由插件模型 API 管理，密钥保存在宿主 Vault，设置页面不会回显原文；不因增加入口把模型 / 密钥迁入公开 Config。画布右上角仍是额外快捷弹窗，与 Harness 设置中的模型页访问同一份全局配置；不是每张画布各存一份模型。

## 备选方案

| 方案 | 不采用的原因 |
| --- | --- |
| 只看在线 README 就推断签名 | 可能与安装 SDK 版本不同，漏权限 / 取消语义 |
| 从宿主私有实现拷贝调用 | 升级不受公开契约保护 |
| 为画布重做认证 / 工作区 / 凭据 | 多一套所有权和生命周期，降低集成可靠性 |

## 后果

正面：公开边界与本项目决定可追溯；反例可以转成回归用例；SDK 升级时有明确检查路径。

负面：版本核对需要持续维护；SDK RC 阶段仍会变化；模拟 Context 的测试不能代替目标 profile 的实际加载与用户 UI 验收。

## 可逆性与重审条件

SDK 变化只调整适配层，不能偷偷扩大认证或改变已接受任务身份。官方服务新增可靠持久队列、事务或取消能力时重审，不因新服务名字相似就替换事实来源。

## 验证与证据

[Host apply / Config](../../src/host/index.ts)、[Client 设置注册](../../src/client/index.tsx)、[模型表单](../../src/client/Settings.tsx)、[credentials](../../src/host/credentials.ts)、[Runtime](../../src/host/runtime.ts)、[构建](../../scripts/build.mjs)、[依赖版本](../../package.json)。
[服务测试](../../tests/service.test.ts)覆盖路由 / 清理、请求断开后继续、外部 ID / 旧 Key 恢复；真实 Harness UI、目录选择器后端与模型联调均不以文档阅读代替验收，见[验证记录](../verification.md)。
