# 运行、配置与排障指南

文档类型：操作指南；负责人：项目维护者；最近核对：2026-10-27。复核周期和触发条件见[文档导航](index.md)。

首次体验见 [README](../README.md)；最低 Node.js 22.13（SQLite Worker）。SDK 编译基准 Harness 0.2.1-rc.2，更宽版本范围不等于均已验收。

## 本地开发

在项目目录执行：

```bash
npm ci
npm run dev
```

使用 <http://127.0.0.1:5173> 打开根页面获取本机会话 Cookie，再操作接口。默认数据 `.dev-data/`；图片 / 视频调用本地Mock，语音使用配置的FishTTS真实服务。开发服务绑定回环地址，并检查 Host、Origin 和跨站请求；不作为远程公开部署入口。

环境变量可更改端口和路径：

```bash
CANVAS_PORT=5174 CANVAS_DATA_DIR=./.canvas-local npm run dev
```

开发页只支持这两个环境覆盖，其他服务参数固定为当前默认值。关闭终端用 Ctrl+C；避免强杀导致恢复状态不明。

## Harness 安装、更新与测试 profile

首次准备：

```bash
npm install -g @deepseek-ai/dsh@0.2.1-rc.2 pnpm
npm ci
npm run check
npm pack
```

如果尚无 canvas-test profile，执行一次：

```bash
dsh --profile canvas-test --from-default-profile web --help
```

`--from-default-profile` 会重建 profile，不放进日常启动命令。安装使用绝对包路径：

```bash
dsh plugin --profile canvas-test add /Users/bytedance/Documents/dsh-canvas/dsh-canvas-0.2.29.tgz
```

安装会加入包内的 `cordis.patch.yml`。在首次启动测试实例前设置独立数据目录，例如 `/Users/bytedance/Documents/dsh-canvas/.harness-test-data`。编辑对应 profile 的 `cordis.patch.yml`，在已有 `canvas` 条目的 `config` 下加入 `dataDir`；保留原文件其他结构，不用下面片段覆盖整个文件：

```yaml
config:
  dataDir: /Users/bytedance/Documents/dsh-canvas/.harness-test-data
```

通常 profile 文件位于 `~/.dsh/profiles/canvas-test/cordis.patch.yml`，设置 `DSH_HOME` 时在相应目录。profile 独立不等于插件数据独立；未配置 dataDir 的实例都会使用同一默认存储目录。

启动：

```bash
dsh --profile canvas-test --port 8080
```

打开认证链接进入“无限画布”，先显示项目列表；在列表创建画布 / 文件夹，点击画布进入编辑器，无需创建 Harness 会话工作区。更新后停止旧实例、重新安装并启动，检查自定义配置是否保留。

对话中打开右侧侧边栏，在“开始页”选择“无限画布”。宿主负责标签切换 / 停靠，左侧全页入口仍可用；两处共享同一目录和模型配置。侧栏切换保留当前画布与草稿，隐藏时停止媒体播放 / 轮询，恢复显示不自动重播；关闭标签或刷新后新开回项目列表。入口缺失时核对实际安装0.2.23及client依赖sidebar-right，不能以开发页5173判断侧栏集成；[手动清单](manual-tests.md)129–132。

已有 Web profile 也可用 `dsh plugin --profile web add <绝对包路径>` 后 `dsh web`。生产使用前按[验证记录](verification.md)补齐真实模型和人工验收。

Harness 的“设置 → 无限画布 模型设置”与画布内设置弹窗访问同一份模型配置。“通用设置”的浅色 / 深色 / 跟随系统会即时改变整个插件的界面配色，媒体文件和 SVG 图标自身的颜色保持原样。插件没有独立主题偏好；独立开发页使用深色兜底。

选中单个节点会点亮其直接上下游Bezier连线，蓝色亮段从输出端流向输入端。多选 / 框选 / 隐藏时停止，系统减少动态效果时为静态蓝线；无需配置或数据迁移。0.2.29修正原动画无单位calc终点，若亮段静止先核对实际preload加载此版；实际流向 / 流动由用户按[清单](manual-tests.md)142–145验收。

画布顶部“任务”可查当前owner的所有未删除画布任务。输入ID / 目录名称、选类型和提交时间后点查询；默认每页20，底部分页可改条数 / 跳页；详情用“返回列表”恢复上下文。日期范围用浏览器本地时区，单侧有效。翻页不纳入上限之后新任务，重新查询可刷新。该功能不需配置或数据迁移；原API保留。查询失败可重新查询，若接口不存在，核对实际安装至少0.2.25及新增task-search路由；输入框 / 分页盒模型、固定列宽和缩略ID左侧复制图标从0.2.26提供。不能用5173判断本机3080加载版本。

TTS在上述设置底部“FishTTS语音服务”配置完整接口地址和ModelLink API Key，保存后可添加“语音生成”节点。密钥输入留空保留已有版本；主动清除才移除。音色ID在各节点输入，默认语速1 / 音量0。配置更新不改变已接受任务；备份dataDir时包含tts-settings.json及相应Vault版本。未配置不会提交；真实音色 / 情绪效果由用户联调，未知提交勿盲目重生成。

## 日常开发自动交付

默认交付流程以 [ADR-0021](adr/0021-local-update-and-package-retention.md) 为准；开发执行者先读根目录 [AGENTS](../AGENTS.md)。每轮修改完成后主动执行必要检查、版本同步、构建 / 打包、安装、重启和加载核验，再向用户交付。

当前已有本机 `web` profile运行于3080；日常更新先备份profile配置并正常停止已核实的目标进程，使用 `dsh plugin --profile web add <已核验tgz的绝对路径>`，随后 `dsh --profile web --port 3080 --no-open`。保留既有模型、数据和任务身份，不重复profile初始化，不操作5173实例。

开发执行者启动驻留Harness时使用独立macOS Terminal窗口运行上述命令，避免服务随临时执行会话清理而停止；日志重定向到工作区外0700目录中的0600文件，不在终端显示认证链接。核对监听PID对应web / 3080和独立Terminal进程链，并认证核验根页 / 插件接口 / 实际client preload。独立Terminal窗口需持续运行；重启前仅正常停止已核实的监听进程。

更新成功后根目录只留最新已核验tgz。新包未验证成功时保留上一可用包用于失败回退；成功后删除过期包。历史manifest和验证记录是身份依据，不代表旧压缩包仍可取得。浏览器视觉和交互继续由用户手动验收。

根目录 `dsh-canvas-*.manifest.json` 保留源码 / lib / 包hash身份；`package.json`、`package-lock.json`、`tsconfig*.json` 是构建必需文件。一次性review/runtime JSON和临时路径TXT放受限系统临时目录。封面运行依赖sharp与ffmpeg的当前平台原生包，安装时不得跳过optional依赖；当前已验证macOS arm64。封面目录 `dataDir/previews` 仅缓存，不必作为恢复来源备份；停机后可删除重建，不删除media、staging或数据库。封面失败先核对平台依赖、格式 / 解码限制和空间，再刷新重试；不会重提付费任务。

音频幅度缓存为 `dataDir/previews/waveforms`，复用ffmpeg；单次解码20秒超时 / 最多2小时采样，独立串行16身份队列，失败冷却30秒。音频波形加载失败时先检查原音频播放 / 下载和解码格式；波形不是音高或音频编辑结果，不改变原素材。缓存可停机删除重建。

## 插件配置表

权威定义：[host/index.ts](../src/host/index.ts)。配置修改后重启生效；dataDir 在宿主解析为绝对路径，建议直接填写绝对路径。

| 配置 | 默认值 | 校验范围 | 实际含义 |
| --- | --- | --- | --- |
| `dataDir` | `~/.dsh-canvas` | string | SQLite、公开配置、恢复暂存；默认媒体子目录，只允许一个写者 |
| `maxConcurrentTasks` | 2 | 整数 1–8 | 同时网络 / 保存步骤；不是远端总任务数上限 |
| `pollIntervalMs` | 3000 | 整数 500–60000 | 宿主视频查询 / 临时故障等待间隔；浏览器读状态另为 2 秒 |
| `requestTimeoutMs` | 120000 | 整数 1000–600000 | 单次供应商请求 / 下载超时，单位 ms；不是整项生成总时长 |
| `maxMediaBytes` | 209715200（200 MiB） | 整数 1024–1073741824 | 单个导入 / 输出文件上限；不是总磁盘或内存上限 |
| `maxReferenceBytes` | 20971520（20 MiB） | 整数 1024–104857600 | 单次生成全部参考图的总字节数 |

同级 config 内容示例：

```yaml
config:
  dataDir: /absolute/path/to/canvas-data
  maxConcurrentTasks: 2
  pollIntervalMs: 3000
  requestTimeoutMs: 120000
  maxMediaBytes: 209715200
  maxReferenceBytes: 20971520
```

## 备份、迁移与恢复

1. 等待图已保存，停止使用该 dataDir 的全部实例，确认进程退出。不要复制正在写的单个 SQLite 文件。
2. 复制整个 dataDir，包括 SQLite（存在 WAL / SHM 也一并复制）、models、bindings、staging、旧源和开发 vault；另备份所有媒体根目录 / 历史位置。Harness 还须备份 credentials 提供方记录，具体位置由宿主提供方维护。保留目录0700 / 文件0600。
3. 媒体位置为绝对路径；恢复时先让数据库登记的原目录可访问，再用设置中的新根目录做受控迁移。不能仅恢复 DB 而忽略媒体与凭据。
4. 配置 dataDir，启动单实例。离线恢复残留 .writer / heartbeat 锁须先确认没有活写者再处理；不要删运行中锁。正常停机会释放锁。
5. 核对目录、图、原 ID、结果与任务详情；已知外部 ID 只恢复原查询，没有回执的 issued 任务保持待确认。

从0.1.0升级：**先停旧实例并备份，再启动新插件**。旧 workspaces / tasks / credentials.json / UUID媒体不改写；新库复制媒体、导入图和私有凭据版本，迁移 checkpoint verified 后才开始执行。源 hash 变化则停止导入，请使用完整静止备份排查，不手工改 checkpoint。

回退旧版须停止新实例，切回升级前的完整数据目录及0.1.0包。新版本期间新增画布 / 编辑 / 结果不自动回写旧 JSON；不能在同一目录让新旧版同时运行。

设置中的媒体根目录是运行 Harness 的电脑绝对路径。改根目录 / 画布名 / 资源名会排后台复制清单，失败读旧文件并可点重试。旧来源、暂存及历史位置当前不自动清理，需要额外空间；不要依据“画布上看不到”删除。

SQLite事务不等于 SQL / 文件 / 凭据 / 外部服务整体原子。Host 停机时取消可取消IO并等待收尾，不保证OS阻塞调用固定时间内返回；已接受任务刷新 / 关面板继续，停宿主期间停止。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 无限画布 / 模型设置入口不存在 | 确认安装到正在运行的 profile；重新打包安装后重启，检查宿主基准和插件加载日志 |
| `React is not defined` | 当前根 tsconfig 采用自动 JSX runtime，开发入口与构建沿用对应配置；重启 Vite 并刷新，检查启动目录和 JSX 配置，不要只改一个入口 import |
| 403 / 无认证 | Harness 用打印的认证链接；开发先打开根页面，使用同源接口，不用无 Cookie 的 curl 判断页面功能 |
| `STORE_LOCKED` | 查找是否有另一实例使用同一 dataDir；停止旧实例或为测试配置独立路径，不删除存活写者的锁 |
| 图保存冲突 | 先导出草稿，再重新载入；不能用“保存”覆盖其他窗口修订 |
| 提交结果待确认 | 有供应商 ID 时恢复查询；无 ID 时核对供应商侧，再决定结束本地等待。重新生成可能再次计费 |
| 修改了模型 Key，但旧视频查询仍失败 | 已提交任务使用旧密钥和原地址；目前没有在 UI 修改任务凭据的入口 |
| 结果保存失败 | 检查空间、目录权限、下载可达性，再重试保存同次结果；过期 URL 或缺私有数据可能仍无法恢复 |
| 本地媒体不可用 / 播放失败 | 核对 DB 登记位置和完整备份；再上传创建新节点并主动连接。签名通过不保证编码可播放 |
| 搬移失败 | 检查目标盘、空间、权限；原文件保留，设置中重试；不要删除 file_operations 清单 |
| MIGRATION_SOURCE_CHANGED | 停机核对旧源是否被其他版本修改，用完整静止备份排查 |
| 选择模型后引用不能生成 | 按协议移除多余 / 不支持的引用，核对格式和尺寸；详见[模型协议](providers.md) |

收集问题时记录插件 / Harness / Node 版本、任务状态、脱敏错误、复现操作和时间。不要把 credentials / tasks 私有文件、认证链接或密钥贴到公开问题里。

## GPU 条件诊断

在页面 Console 查看：

```js
document.querySelector('.dc-canvas-area')?.dataset
```

`gpuCompositing: "enabled"` 表示探测通过、允许短暂平移合成提示；reason为hardware-webgl或hardware-webgpu。viewportMotion为pan时才提示，zoom / idle释放；无变换200ms转idle。checking是等待；software-renderer / unverified / unavailable / unsupported-css保留默认方式。未知显卡信息不会强制启用。

检查 `.react-flow__viewport` computed style：硬件允许且pan时will-change为transform；zoom / idle时auto，translate始终none，React Flow自己的inline transform持续变化。若放大后文字发虚，先确认已加载0.2.20及此状态切换，再记录倍率 / DPR和图层；不通过逐节点translateZ强制缓存。Chrome可结合chrome://gpu与DevTools Layers / Performance观察实际图层和开销；dataset不证明视觉或GPU提升，见[ADR-0032](adr/0032-scale-aware-viewport-compositing.md)。

目标浏览器手动比较空图、图片、视频和混合图的拖动 / 连续缩放、播放、内存和恢复。尚无 p95 / p99 帧时间、节点容量和显存余量测量；验收步骤见[手动清单](manual-tests.md)。
