# 运行、配置与排障指南

文档类型：操作指南；负责人：项目维护者；最近核对：2026-10-29。复核周期和触发条件见[文档导航](index.md)。

首次体验见 [README](../README.md)；最低 Node.js 22.13（SQLite Worker）。SDK 编译基准 Harness 0.2.1-rc.2，更宽版本范围不等于均已验收。

## 本地开发

新增可创建节点类型先维护 `src/client/nodeCreation.ts` 的注册与工厂、shared合同与模型限制，再维护节点渲染 / 编辑和图标。执行nodeCreation / nodeCreationMenu专项并逐一验收底部添加、空白右键、输出拉线创建；不得只改底栏或另写类型数组。快捷引用须原子保存节点 / 边，临时线不写图。维护规则见[ADR-0066](adr/0066-shared-node-creation-entrances.md)。

在项目目录执行：

```bash
npm ci
npm run dev
```

使用 <http://127.0.0.1:5173> 打开根页面获取本机会话 Cookie，再操作接口。默认数据 `.dev-data/`；图片调用配置的GPT Image 2.5、Nano Banana或Seedream真实服务，语音使用FishTTS真实服务，视频使用Seedance。画布无配置时显示“请前往设置页面配置模型”，没有Mock后备项。开发服务绑定回环地址，并检查 Host、Origin 和跨站请求；不作为远程公开部署入口。

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
dsh plugin --profile canvas-test add /Users/bytedance/Documents/dsh-canvas/dsh-canvas-0.2.59.tgz
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

Harness的“设置 → 无限画布”与项目列表 / 画布设置弹窗共享对象存储、模型设置、TTS设置与Seedance预审四个标签。“通用设置”的浅色 / 深色 / 跟随系统即时改变插件配色；媒体文件和SVG自身颜色保持，独立开发页深色兜底。

Seedance预审：分别保存Bytedance / BytePlus的ProjectName、AK/SK，三项默认隐藏，眼睛单独查看；AK/SK替换成对，留空保留。测试连接只验证当前项目ListAssetGroups读取，不证明创建权益或真人认证。新画布登记已配置供应商的AIGC组并后台创建，旧画布首次送审懒建；每家最多2个网络步骤，独立队列不占生成任务并发。真人素材先到官方控制台认证，再选对应人物组。

0.2.55未保存任何预审配置时节点隐藏盾牌，也不会建组；至少配置一家后显示，新建画布后台建组，旧画布仍可首次送审时补组。配置读取期间 / 失败先隐藏，设置保存 / 关闭、画布恢复时刷新。无需等待Group ID返回才能点击；送审继续等待组。折叠历史的盾牌、下载与展开合并同排；悬停节点操作栏时双指捏合、⌘ / Ctrl +滚轮缩放画布，编辑器滚动与按钮点击保持。用户验收238–240。

0.2.56补齐操作栏上的双指平移：普通wheel两轴移动 / 惯性也转交画布，倍率保持；捏合仍缩放，按钮点击 / 拖动保护与编辑器内部滚动不变。刷新3080后按241验证黑色按钮及SVG上的横向 / 纵向移动。

0.2.57同素材两家均Active后隐藏送审按钮，名称旁标记保留。弹窗供应商已送审 / 未配置项禁用，悬停提示原因，默认选择未送审且已配置的一家；全部禁用时可打开菜单查看原因，不能提交。440px紧凑弹窗去掉重复标题 / 文件名和审核通过详情 / 底部说明，失败仅展示原因与明确重试，待确认保留原任务核对 / 恢复。列表新建 / 重命名画布及文件夹统一使用Harness Modal / Input；失败保留草稿，取消不写入。刷新3080按242–245人工验收。

0.2.58在“素材路径”旁新增圆圈问号，悬停 / 键盘聚焦显示两种送审分组的区别；点击也可展开阅读。使用Harness公开Tooltip与主题，删除虚拟素材下方常驻说明；真人组选择 / 认证入口保持。刷新3080按246验收。

0.2.59画布及其菜单默认禁止选中文字，输入框 / 提示词 / TTS文字与指定历史复制区域开放；节点框选 / 拖动 / 连线保持。公共接入与后续开发规则见[ADR-0060](adr/0060-canvas-text-selection-opt-in.md)，刷新3080按247–250验收。

0.2.60隐藏右下角 React Flow 署名，文件加载改用 libraries.dev/image 的真实黑白像素效果；任务生成保留 Beam / Orb，失败保留红色感叹号。主题、表面色、隐藏 / 离屏 / 减少动态效果跟随 Harness；无WebGL2或初始化失败使用静态方块。媒体阶段替代下文历史的文件 Orb 描述，见[ADR-0061](adr/0061-dependency-backed-media-pixel-loading.md)，用户251–254验收。

0.2.61节点视频播放器打开后可从画面、时间文字或留白直接拖动节点；播放按钮与进度条保持控制用途。播放器上双指平移 / 捏合和Command / Ctrl缩放交给画布原生处理，包含按钮 / SVG / 进度条区域；不关闭播放器、不重置时间，原预览与编辑面板仍隔离。规则见[ADR-0024](adr/0024-custom-video-and-chromeless-preview.md)，人工255–257。

0.2.62将节点Delete / Backspace确认改用Harness Modal / Button，默认聚焦取消，支持取消 / Escape / 关闭；弹窗打开期间任务变化会在确认时重新检查，隐藏或离开取消等待。保留原连线删除、媒体及下游结果；本轮合并安装此前0.2.61的视频拖拽 / 双指手势修复，见[ADR-0062](adr/0062-harness-node-delete-confirmation.md)，人工255–260。

0.2.67拖拽 / 按钮上传支持分块断点续传和五路并发；顶部最多五枚圆环百分比胶囊横向叠放，其余显示「+N」，未结束可继续追加。无静态边框、轻阴影和可见彩色Beam，表面与光晕强度跟Harness黑白主题；首次上方进入、追加右侧叠入、完成左侧补位。断网恢复自动继续；刷新后默认项目列表也会启动缓存恢复，不自动打开旧画布。重新打开对应画布查看胶囊；页面关闭期间不传输，已接受导入仍在Host运行。登录过期需重新登录相同Harness来源，不能从127.0.0.1切到localhost期待共享缓存。浏览器缓存空间 / 权限不足会在创建占位前报错；清缓存或换浏览器丢失原Blob后不能自动续传。五路为当前浏览器共享管理器上限，后台OSS导入仍按原调度。

0.2.67按松手落点隔离画布与Agent附件：画布内唯一接收并隐藏无关Agent蒙版，移出保持宿主原规则。已核对宿主附件0.2.1-rc.2的document冒泡 / window dragend清理；后续升级宿主若监听阶段变化，复核[ADR-0065](adr/0065-exclusive-canvas-file-drop.md)与人工272–275，不能修改宿主生成CSS或关闭全局附件上传。

0.2.68统一三类生成输入区的无边框底色：浅色比卡片稍深，深色稍浅，随Harness主题即时变化。刷新3080按276–277查看图片 / 视频提示词与FishTTS文字；输入高度、@标签、草稿与任务保持。

0.2.69图片 / 视频提示词初始高度和内边距与TTS统一为70px / 10px，空白或一行输入也保持该高度；继续随内容增高到220px后内部滚动。刷新3080按278验收，原底色与输入行为保持。

0.2.70图片 / 视频节点无引用时移除连线说明和空参考行，上传按钮后直接显示提示词；有引用仍展示缩略图并支持移除。刷新3080按279验收，原连线 / 上传与70px输入区保持。

备份必须包含staging内upload与resume.json。收到进度代表块已fsync并提交journal，重启复核块hash，仅清理未提交尾部；暂存损坏明确结束，不创建导入。Host到OSS的失败仍按原任务“重试保存”，不重新上传原文件。回退至0.2.62前确认没有续传receiving，或停机恢复同一完整备份；不得删暂存或改会话为失败来绕过检查。见[ADR-0063](adr/0063-resumable-uploads-and-progress-capsules.md)，人工261–266。

审核中关闭面板 / 返回列表不取消，宿主重启恢复查询。待确认有官方Asset ID时用“恢复查询”，无ID用“核对提交结果”；不明结果不会自动重传。只有明确失败可“重新送审”；结束本地等待不取消云端资源。通过后当前供应商下一次视频生成传asset://ID，其他情况传原URL，当前已接受请求不会被后来审核更改。EP必须处于对应预审项目下；云端权限撤销造成的引用错误不会自动改URL或重提。

备份与回退新增约束：停机备份整个dataDir，包括canvas.sqlite、seedance-review.sqlite、Vault / 配置和媒体定位；不能只恢复主库。新预审生成绑定未排空时禁止直接装回0.2.53继续派发，必须先排空或保持新版停止派发 / 查询，必要时恢复共同停机备份。云端组与Asset不自动删除；队列阶段与脱敏审计保存在独立库。详情错误中的签名URL / 凭据均隐藏，不输出认证日志。见[ADR-0059](adr/0059-seedance-asset-review-and-frozen-generation-references.md)及[手动验收](manual-tests.md)231–237。

首次使用先在对象存储填写已有私有Bucket、地域、标准外网HTTPS Endpoint、AK与前缀，测试连接 / 保存启用。默认前缀dsh-canvas；首期只实现阿里云OSS，禁止内网Endpoint。没有活动配置不能新建画布，提示“请前往设置页面设置对象存储”。

RAM授权限于所用Bucket / 前缀内的读、写、复制及探测对象删除；不要求ListBuckets。Bucket CORS精确允许 `http://127.0.0.1:3080`（若使用localhost或开发页需分别添加实际来源），GET / HEAD、Range及必要响应头。插件不自动修改Bucket权限 / CORS / 防盗链；Host测试通过不代表浏览器跨域已通过。

保存新配置先探测再revision CAS切换，失败旧配置保持。只有一个活动新写入目标，停用配置仍供历史读取；已接受上传 / 生成固定原目标与凭据版本。同Bucket / 地域 / 前缀轮换读取凭据并失效链接缓存，原任务密钥不变；不要提前撤销未完成任务使用的旧AK。新Bucket需保留旧Bucket与读取凭据，首期不跨提供商迁移或自动删除旧对象。

选中单个节点会点亮其直接上下游Bezier连线，蓝色亮段从输出端流向输入端。多选 / 框选 / 隐藏时停止，系统减少动态效果时为静态蓝线；无需配置或数据迁移。0.2.29修正原动画无单位calc终点，若亮段静止先核对实际preload加载此版；实际流向 / 流动由用户按[清单](manual-tests.md)142–145验收。

画布顶部“任务”可查当前owner的所有未删除画布任务。输入ID / 目录名称、选类型和提交时间后点查询；默认每页20，底部分页可改条数 / 跳页；详情用“返回列表”恢复上下文。日期范围用浏览器本地时区，单侧有效。翻页不纳入上限之后新任务，重新查询可刷新。该功能不需配置或数据迁移；原API保留。查询失败可重新查询，若接口不存在，核对实际安装至少0.2.25及新增task-search路由；输入框 / 分页盒模型、固定列宽和缩略ID左侧复制图标从0.2.26提供。不能用5173判断本机3080加载版本。

设置页按供应商卡片汇总已保存模型，跨协议的Model Link归入一卡。每个模型右侧“编辑”直接打开原组合表单，官方EP回填、Key留空保留；编辑固定型号 / 供应商，取消无写入，失败保留草稿。卡片“配置模型”只选当前供应商支持型号，顶部通用入口继续先选模型再选供应商。地址固定且不展示，GPT按模型配置Model Link / OpenAI，Nano Banana配置Model Link / Gemini。清除只移除当前组合Key；缺EP的已存Key配置显示待完善。画布Model Link优先且默认，未配置不会提交；切换表单选择清空未保存Key，切换节点供应商不执行下游。尺寸与枚举见[协议参考](providers.md)。

0.2.42接入Nano Banana Pro / 2 / 2 Lite / 2.1，刷新3080后从“设置 → 无限画布 → 模型设置 → 配置模型”选择型号和供应商保存Key，随后在生图节点选择已配置组合。Gemini用x-goog-api-key，Model Link用Bearer，Host自动处理。结果Base64保存OSS，下载格式按实际图片；默认1K / 1:1，每次1张，Lite仅1K与最多1图参考，其他最多14图。2额外提供0.5K，Pro / 2 / 2.1可选2K / 4K。401检查所选渠道Key，404核对账户模型可用性；unknown先核对供应商，不盲目重生成。真实双渠道验收181–185，见[ADR-0048](adr/0048-banana-native-image-protocol.md)。

0.2.43修正Model Link Banana为`/v1/models/{model_id}:generateContent`，contents / generationConfig请求与candidates Base64返回，Gemini保持Interactions。若旧任务提示`Invalid URL (POST /v1beta/interactions)`，刷新确认实际0.2.43后主动点生成创建新任务；已有Key与节点参数无需重配，旧失败记录不删除 / 重提。无候选 / 不完整返回不自动换协议。验收186–189，见[ADR-0049](adr/0049-modellink-banana-generate-content.md)。

0.2.48新增Seedream 5.0 Lite / Pro（Model Link / ByteDance）与Dola Seedream 5.0 Lite / Pro（NSFW、BytePlus）。“模型设置 → 配置模型”选择型号和渠道：ByteDance / BytePlus填写独立Key及当前型号EP，Model Link只填Key。保存后刷新画布，菜单只显示完整配置组合；画布 / 历史 / 任务中心仍显示型号，不显示EP。留空Key保留，切换表单清除未保存Key / EP并读取所选组合已有值，配置轮换不改变已接受任务。默认2K / 1:1 / 单张；Pro支持1K / 1.5K / 2K与10参考图，Lite支持2K / 3K / 4K与14图，仅文生图 / 图生图。401检查当前渠道Key，模型不可用检查EP是否部署对应型号；unknown先查供应商记录，不重提原任务。验收206–210，见[ADR-0053](adr/0053-seedream-endpoint-routing-and-model-identity.md)。无需改表或清理历史；回退须使用能读取Seedream新快照的版本并保留新任务。

0.2.38起1K补齐16:9 / 9:16 / 21:9，超宽标签由7:3改为21:9；1K宽屏长边为1280或1344，按钮悬停可看实际宽高。2K / 4K尺寸保持；若仍缺少比例，核对3080实际客户端版本并刷新，不能用旧5173实例判断安装内容。

TTS也通过“配置模型”选择FishTTS / Model Link配置独立API Key，使用固定接口地址与model: s1 Header。没有Key或清除Key后，语音节点显示“请前往设置页面配置模型”并禁用生成；读取中 / 失败同样不能提交，失败可刷新重试，输入草稿仍可编辑。保存配置或恢复画布会重新读取资格。密钥留空保留已有版本；主动清除才移除。音色ID在节点输入，默认语速1 / 音量0。配置更新不改变已接受任务；备份包含tts-settings.json及Vault版本。真实音色效果由用户联调，未知提交勿盲目重生成。

## 日常开发自动交付

0.2.53统一Key / EP与FishTTS / OSS密钥脱敏及眼睛显隐。模型卡片保留头尾、中间星号；编辑默认password，点击才查看完整值，只查看不改变保存草稿，留空仍保留。关闭 / 切换 / 隐藏页清除预览，慢响应不串配置；读取失败可显式重试。刷新3080按228–230人工验收，原Key / EP / Vault / 任务无需重配，不自动生成；见[ADR-0058](adr/0058-masked-settings-and-explicit-secret-reveal.md)。完整值接口仅owner单字段只读，常规GET继续掩码。

0.2.52以供应商卡片替代模型长行，支持逐项编辑和卡片新增；网格按设置面板宽度调整列数，长模型列表可滚动。刷新3080后按224–227验收卡片、原组合EP / Key编辑、取消 / 清除、窄窗口 / 主题与键盘。更新不修改配置、任务或图，原Key / EP无需重填；见[ADR-0057](adr/0057-provider-cards-and-direct-model-editing.md)。

0.2.51取消手动文生选择：无引用自动文生，连接 / 上传 / @加入任意首份素材默认参考；有引用才显示参考 / 首尾帧下拉，frames只手动选择。删除全部引用恢复文生并清除角色，重接默认参考；原任务按原快照查询 / 保存。刷新实际3080版本后按220–222验收，无需重配Key / EP / OSS或重新生成。模式随入边同次保存，旧图 / 23表 / 凭据与已接受任务保持，见[ADR-0056](adr/0056-seedance-mode-inference-from-references.md)。

0.2.50接入Seedance八型号十二组合。在模型设置选择Doubao或Dreamina型号：标准版Model Link / ByteDance，NSFW仅BytePlus；官方填写Key和对应EP，Model Link只填Key。生视频参数选文生 / 参考 / 首尾帧，参考可混接图 / 视频 / 音频；首尾帧最多两图，逐图指定角色，2.5自动跟随首帧比例。模式不兼容时先移除连线，不能混用。画布 / 任务中心始终显示名称 / ID。提交前逐份读取OSS做实际媒体检查，再签名24小时URL；查询至少3秒。没有ID的失败不自动重提，有ID重启只查原ID / Key；结果保存失败恢复同输出。能力 / 编码限制见[协议](providers.md#seedance能力与供应商)，验收214–219。更新前完整停机备份profile / dataDir / Vault，DDL / 23表、原模型 / 图 / 媒体 / 任务完全保持；已有Seedance新数据后不得用旧协议包覆盖恢复。

0.2.49将拒绝、超时和无有效结果的提交标为失败，画布显示红色感叹号；自动修正符合条件的旧待确认任务，不重提。固定Lite配置ID更正为doubao-seedream-5-0-260128 / dola-seedream-5-0-260128，UUID / EP / Key及历史快照保持；Pro保持。升级前完整停机备份dataDir / profile / Vault，核验只允许这些更正和正常宿主runtime token轮换，23表 / DDL及原任务尝试保持。失败表示本地没有得到可用结果，供应商扣费以其记录为准。验收211–213，见[ADR-0054](adr/0054-no-result-submission-failure-and-seedream-id-correction.md)。

0.2.44起同节点再次生成立即进入提交历史堆叠，顶部为最新提交，完成不重排；展开后逐素材连线，无设主图，收起无可见输出。旧任务执行不锁定下一次参数编辑，只有本次保存 / 派发期间锁定。明确拒绝撤回临时卡片，响应不明按requestId等待核对，不盲目重生成。验收190–196，见[ADR-0050](adr/0050-submission-history-and-expanded-result-ports.md)。

0.2.46展开提交历史后点击素材，只读查看当次提示词 / 参数；修改前收起并重新点击堆叠，恢复最后提交后编辑。读取失败时重新展开 / 收起重试；待接受任务先等待原回执，不能重提。原模型已取消配置时历史可查，新生成仍需可用模型和有效引用。验收197–201，见[ADR-0051](adr/0051-readonly-submission-inspection.md)。

从0.2.43升级本轮须完整停机备份dataDir / profile / Vault：启动会在事务中将task_active_node旧唯一索引改为非唯一，允许同节点多个活动任务；user_version=3、全部表字段和行保持，不执行历史清理。核验只允许此索引定义差异，逐表审计并核对原Key / 图 / 任务。失败恢复旧包 / profile优先，不能覆盖安装后新接受的数据；旧包仍有提交忙碌保护，不会自动恢复唯一索引。

0.2.41起中央Orb按屏幕DPR与画布倍率提高真实像素数，采用1–8倍整数档位，显示仍为64 / 20px；独立预览只跟屏幕密度。平移不重绘，主题与隐藏暂停保持。补丁由安装、类型 / 测试与构建入口校验，依赖版本 / hash变化必须重新核对。若放大后Loading仍软，先刷新并核对实际加载0.2.41，再记录DPR / zoom；原图超过自身分辨率的插值仍存在。详见[ADR-0047](adr/0047-zoom-aware-loading-resolution.md)，用户验收179–180。

0.2.40起任务和文件加载的Loading覆盖整个节点，使用不同Beam / Thinking Orb样式，不显示状态文字；0.2.49起failed / unknown / save_failed显示静态红色感叹号，优先于媒体加载。成功后继续等图片解码 / 视频首帧 / 音频元数据和波形读取结束，图片就绪前不显示原生图标 / 文件名；终态媒体错误停止等待并显示错误。浅 / 深 / 跟随系统由Harness实际主题控制，减少动态效果、隐藏侧栏 / 页面和离屏时暂停CSS并释放pulse JS循环；不重生成已有媒体。若仍看到旧角落spinner，核对3080安装及实际preload后刷新。人工验收见[清单](manual-tests.md)175–178、211，后续选型询问规则见[ADR-0046](adr/0046-dependency-backed-whole-node-loading.md)。

从0.2.36起，节点上方按钮与下方编辑卡片超出窗口时保持原本节点锚点，手动平移 / 缩放查看；固定底部工具栏及左下角控件在其上方，不再自动上移卡片。窗口变小也不缩小卡片宽度，见[ADR-0042](adr/0042-node-anchored-overlays.md)。

默认交付流程以 [ADR-0021](adr/0021-local-update-and-package-retention.md) 为准；开发执行者先读根目录 [AGENTS](../AGENTS.md)。每轮修改完成后主动执行必要检查、版本同步、构建 / 打包、安装、重启和加载核验，再向用户交付。

当前已有本机 `web` profile运行于3080；日常更新先备份profile配置并正常停止已核实的目标进程，使用 `dsh plugin --profile web add <已核验tgz的绝对路径>`，随后 `dsh --profile web --port 3080 --no-open`。保留既有模型、数据和任务身份，不重复profile初始化，不操作5173实例。

开发执行者启动驻留Harness时使用独立macOS Terminal窗口运行上述命令，避免服务随临时执行会话清理而停止；日志重定向到工作区外0700目录中的0600文件，不在终端显示认证链接。核对监听PID对应web / 3080和独立Terminal进程链，并认证核验根页 / 插件接口 / 实际client preload。独立Terminal窗口需持续运行；重启前仅正常停止已核实的监听进程。

更新成功后根目录只留最新已核验tgz。新包未验证成功时保留上一可用包用于失败回退；成功后删除过期包。历史manifest和验证记录是身份依据，不代表旧压缩包仍可取得。浏览器视觉和交互继续由用户手动验收。

根目录 `dsh-canvas-*.manifest.json`保留源码 / lib / 包hash身份；package / lock / tsconfig为构建输入。一次性回执与脚本放受限系统临时目录。封面依赖sharp与ffmpeg当前平台原生包，安装不能跳过optional依赖；当前验证macOS arm64。派生封面 / 波形持久对象在OSS，Host在受控临时目录解码后清理；失败检查平台依赖、格式 / 限额、OSS权限与空间，再刷新重试，不重提付费任务。

音频幅度复用ffmpeg，单次解码20秒超时 / 最多2小时采样；所有派生资源共享独立串行32身份队列、失败冷却30秒。波形失败先检查原音频与编码；波形不改变原素材。不要只删除云端派生对象而保留DB定位；首期没有对象清理入口。

0.2.39起waveform GET / HEAD通过认证Host返回200同源JSON，无OSS跳转；修复“原音频能播、波形fetch被Bucket CORS拦截”。Host只读最多8192字节、有界内存缓存与并发合并，不落盘保存原音频。若仍提示波形不可用，核对实际加载0.2.39、云端派生内容 / 身份与OSS读取权限，不重生成音频。原媒体与preview跨域权限要求保持。所有生图模型按1:1、2:3、3:2、3:4、4:3、4:5、5:4、9:16、16:9、21:9排序，只显示参数允许项，不增加25:9或9:25；4K继续过滤非法项，见[ADR-0045](adr/0045-same-origin-waveforms-and-ratio-order.md)。

## 插件配置表

权威定义：[host/index.ts](../src/host/index.ts)。配置修改后重启生效；dataDir 在宿主解析为绝对路径，建议直接填写绝对路径。

| 配置 | 默认值 | 校验范围 | 实际含义 |
| --- | --- | --- | --- |
| `dataDir` | `~/.dsh-canvas` | string | SQLite、公开配置、未完成恢复暂存；只允许一个写者，无永久本机媒体库 |
| `maxConcurrentTasks` | 2 | 整数 1–8 | 同时网络 / 保存步骤；不是远端总任务数上限 |
| `pollIntervalMs` | 3000 | 整数 500–60000 | 宿主视频查询 / 临时故障等待间隔；Seedance下限3秒，浏览器读状态另为2秒 |
| `requestTimeoutMs` | 120000 | 整数 1000–600000 | 单次供应商请求 / 下载超时，单位 ms；不是整项生成总时长 |
| `maxMediaBytes` | 209715200（200 MiB） | 整数 1024–1073741824 | 单个导入 / 输出文件上限；不是总磁盘或内存上限 |
| `maxReferenceBytes` | 20971520（20 MiB） | 整数 1024–104857600 | 图片字节协议参考总量；Seedance流式参考按单媒体和型号限制 |

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
2. 复制整个dataDir，包括SQLite（存在WAL / SHM一并复制）、models、bindings、tts-settings、staging与开发vault。Harness另备份credentials持久记录及profile；保留目录0700 / 文件0600。
3. 保存各storage_providers所引用Bucket / key / version的对象备份与可读凭据；不能仅恢复DB而忽略云端对象和凭据。正常切换不跨Bucket复制历史，恢复须保留原配置读取能力。
4. 配置 dataDir，启动单实例。离线恢复残留 .writer / heartbeat 锁须先确认没有活写者再处理；不要删运行中锁。正常停机会释放锁。
5. 核对目录、图、原 ID、结果与任务详情；已知外部 ID 只恢复原查询，没有回执的 issued 任务保持待确认。

从0.2.36及更早版本升级：**先停机一致备份，使用schema 3业务库**。新插件明确拒绝schema 1 / 2，不自动导入workspaces / tasks / credentials.json，不自动删除任何安装的数据。需要保留旧画布的其他安装应保持匹配旧包 / 旧目录，另设新dataDir体验OSS；本轮用户已明确批准当前web实例的历史清理。

本轮限定清理顺序：完成自动检查和同包核验 → 重新核对web / 3080 / dataDir与任务状态 → 正常停止监听进程 → 外部0700临时目录取得完整插件和profile / Vault一致备份 → 仅重建当前插件业务库，移出旧media / previews / staging和存在的旧JSON源 → 保留models.json、model-bindings.json、tts-settings.json和Vault / Harness配置 → 安装重启 → 核对schema 3、业务空表、配置hash一致、旧任务未恢复 / 重提。失败恢复完整旧数据及0.2.36核验包；成功后按ADR-0021清理旧tgz。此流程不是正常启动的清空逻辑。

改文件夹 / 画布 / 资源名称或移动画布会排OSS Copy清单；失败读旧对象、设置中重试。旧对象副本保留给固定任务引用，首期无GC。成功暂存清理；未完成暂存不能依据“画布上看不到”删除。

页面签名链接1小时、剩余不足5分钟刷新；恢复标签、播放 / seek / 预览前检查。模型URL协议执行前重新签名24小时，multipart / data URL仍按原协议读取字节。403 / 404持续错误不能靠无限刷新解决；检查AK、Bucket权限、防盗链、CORS、对象是否存在。已交给外部模型的URL无法原地续期。

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
| 结果保存失败 | 检查OSS权限 / 可达性及暂存空间，再重试同次结果；已有暂存不重新下载或生成，尚未得到暂存且输出URL过期仍可能失败 |
| OSS媒体不可用 / 播放失败 | 核对DB定位、Bucket权限 / CORS / 防盗链、对象与凭据；签名通过不保证编码可播放 |
| 搬移失败 | 检查同Bucket Copy / HEAD权限与对象身份；旧对象保留，设置中重试，不删file_operations清单 |
| Unsupported canvas schema | 停机核对旧版本，完整备份后使用新schema 3业务目录；插件不会自动清空或导入 |
| 选择模型后引用不能生成 | 按协议移除多余 / 不支持的引用，核对格式和尺寸；详见[模型协议](providers.md) |

收集问题时记录插件 / Harness / Node 版本、任务状态、脱敏错误、复现操作和时间。不要把 credentials / tasks 私有文件、认证链接或密钥贴到公开问题里。

## GPU 条件诊断

0.2.47修复单节点拖动导致全部节点内容 / 端点测量 / 提示词DOM更新的扇出，见[ADR-0052](adr/0052-position-and-content-render-isolation.md)。若仍断续，记录实际加载版本、节点 / 历史 / 播放数量、编辑器是否打开、倍率 / DPR，以及浏览器Performance中的主线程帧耗时 / 布局 / 绘制；DOM计数、HTTP200与GPU dataset不能作为FPS成绩。先按202–205复核连线 / 最新坐标与输入，再定位剩余开销。

在页面 Console 查看：

```js
document.querySelector('.dc-canvas-area')?.dataset
```

`gpuCompositing: "enabled"` 表示探测通过、允许短暂平移合成提示；reason为hardware-webgl或hardware-webgpu。viewportMotion为pan时才提示，zoom / idle释放；无变换200ms转idle。checking是等待；software-renderer / unverified / unavailable / unsupported-css保留默认方式。未知显卡信息不会强制启用。

检查 `.react-flow__viewport` computed style：硬件允许且pan时will-change为transform；zoom / idle时auto，translate始终none，React Flow自己的inline transform持续变化。若放大后文字发虚，先确认已加载0.2.20及此状态切换，再记录倍率 / DPR和图层；不通过逐节点translateZ强制缓存。Chrome可结合chrome://gpu与DevTools Layers / Performance观察实际图层和开销；dataset不证明视觉或GPU提升，见[ADR-0032](adr/0032-scale-aware-viewport-compositing.md)。

目标浏览器手动比较空图、图片、视频和混合图的拖动 / 连续缩放、播放、内存和恢复。尚无 p95 / p99 帧时间、节点容量和显存余量测量；验收步骤见[手动清单](manual-tests.md)。
