# 验证记录与已知边界

文档类型：参考；负责人：项目维护者；最近核对：2026-10-29。每次交付 / 实测后更新。

## 本次自动化

0.2.72按用户反馈隐藏拉线菜单中不兼容类型，并修复菜单点击不创建：React portal的pointerdown先经过画布捕获，原监听提前关闭菜单；专项改用完整pointer / mouse按下、松开和click后，修正前两项复现不创建，识别菜单目标后修复，并分别覆盖生图 / 生视频。图专项保持普通连接 / 原子保存限制；无兼容项不显示空菜单或临时线，右键和底栏仍完整。21项创建专项与全量、双构建 / 同包安装 / 实际preload及原两库身份见 `dsh-canvas-0.2.72.manifest.json`最终记录；真实鼠标 / 主题验收280–286由用户完成。

0.2.71新增共享节点创建工厂与两个快捷入口。图专项核对默认值 / 注册覆盖、冻结结果 / 历史端点、兼容模型、TTS / MIME / 数量 / 重复 / 循环及无部分状态；真实React Flow工作区使用原生右键和输出端点mouse事件核对变换位置、节点与边同次GraphMutation、取消 / 隐藏 / 来源删除、键盘及顶层命中。Harness组件loader替身仅确认公开契约，浏览器主题 / 手势 / 菜单布局由用户280–285验收。全量、双构建、同包安装 / 实际preload及原两库身份以 `dsh-canvas-0.2.71.manifest.json`最终记录为准，见[ADR-0066](adr/0066-shared-node-creation-entrances.md)。

0.2.70从图片 / 视频生成节点移除“也可从素材节点拖入连线”，无引用时不渲染空参考行；有引用的缩略图 / 移除按钮、上传 / 连线 / @输入与70px编辑器保持。使用既有全量、类型 / 文档及构建回归，不新增文案镜像测试；双构建、同包安装 / 实际preload与原两库 / 配置身份见 `dsh-canvas-0.2.70.manifest.json`最终记录。用户279验收两类节点无说明行及原参考操作。

0.2.69将图片 / 视频提示词的初始高度和留白统一为TTS现有的70px / 10px，空白提示位置同步，三类编辑器共用同一规则并移除TTS重复覆盖；220px上限、自动增高、滚动、背景与编辑逻辑保持。使用既有全量、类型 / 文档及构建检查；双构建、同包安装 / 实际preload与原两库 / 配置身份见 `dsh-canvas-0.2.69.manifest.json`最终记录。用户278验收三类空白 / 短文本 / 长文本高度，不以静态检查代替浏览器布局。

0.2.68仅调整三类生成节点的提示词 / 文字输入区背景，共用Harness文字色5%与卡片表面混合的token，浅色稍深、深色稍浅，无常驻描边。使用既有全量、类型 / 文档与构建回归，不新增镜像CSS测试；双构建、同包安装 / 实际preload与原两库 / 配置身份以 `dsh-canvas-0.2.68.manifest.json`最终记录为准。真实底色强度、主题切换及输入交互由用户276–277验收，不将静态核验视为视觉通过。

0.2.67修复侧栏文件拖放同时进入画布和Agent及无关蒙版问题。新增九项原生DOM边界 / 次序 / 唯一回调 / 非文件 / 隐藏 / 多画布 / 最新回调专项，原真实工作区追加与媒体稳定回归保持；独立离线烟测使用实际Harness0.2.1-rc.2附件包的installDocumentDropEvents与droppedDirectories纯函数验证蒙版及双方文件接收。原接口 / 两库 / 续传 / 五槽 / 彩色胶囊保持。全量、双构建、同包 / 实际preload与原身份核验见 `dsh-canvas-0.2.67.manifest.json`；真实拖放 / 蒙版由用户272–275验收，不以DOM替代。见[ADR-0065](adr/0065-exclusive-canvas-file-drop.md)。

0.2.66纠正用户截图中上传胶囊Beam几乎不可见的问题：恢复真实依赖的colorful配色和非零内侧 / 外侧光晕，分别提高浅 / 深主题强度，使用胶囊自身入场显现边缘，各胶囊隔离绘制层。原真实Beam测试增加彩色渐变、光晕倍率和立即显现参数断言，数量 / 续传 / 动效测试继续；这些核验不等于参考图视觉通过。全量、双构建、同包安装 / 实际preload与两库身份见 `dsh-canvas-0.2.66.manifest.json`；用户267对照彩色参考图验收，268–271保持。

0.2.65新增百项五槽队列与终态失败释放检查，固定种子0x6500cafe逐项乱序完成并验证原UUID / Blob和缓存清理；真实Beam / 五环上限 / +N与补入、首次上方 / 后续右侧进入、进度不重播、连续完成的当前位移、Harness主题 / 暂停 / 卸载及原真实工作区媒体稳定检查。jsdom仅替换布局数值和原生animate，不声明实际像素、阴影或帧率通过。接口29路径、Host journal、两库DDL和原任务身份保持；最终全量、双构建、同包 / 实际preload与两库身份见 `dsh-canvas-0.2.65.manifest.json`。用户已确认0.2.64检查可用，本轮动效 / 百项上传 / 浅深主题人工267–271，见[ADR-0064](adr/0064-bounded-upload-capsules-and-five-transfers.md)。

0.2.64验证真实分块 / SHA-256 / SQLite提交、三媒体HTTP、重复 / 乱序 / 半块、journal与COMMIT后丢ACK、同长度损坏、Host停止等待及重启补传；固定种子0x63c0ffee搜索35步两参与者故障序列并核对最终精确原字节。浏览器使用fake-indexeddb验证原Blob / UUID / 引用目标刷新恢复、响应丢失、登录唤醒、配额失败与追加上传；胶囊语义和真实CanvasWorkspace的多入口 / 分别结束 / 媒体稳定回归。编译Host离线烟测增加4MiB块重启和最终格式拒绝，并禁止Harness流式GET / HEAD注册组合；实际认证HTTP核验原完成会话进度，不访问真实OSS或模型。最终全量、双构建、同包安装、实际preload与23+7表身份以 `dsh-canvas-0.2.64.manifest.json`为准；浏览器配额、真实断网与胶囊视觉由用户261–266验收，见[ADR-0063](adr/0063-resumable-uploads-and-progress-capsules.md)。

0.2.62将节点删除确认接入Harness Modal / Button，合并0.2.61的视频拖拽 / 双指手势修复。删除专项使用真实CanvasWorkspace / ReactFlowProvider、Delete / Backspace与deleteElements，检查确认 / 取消 / Escape / 关闭、初始取消焦点、输入隔离、多节点连线移除与图保存、媒体 / 下游结果保留、任务在等待期间更新、重复请求及隐藏 / 卸载 / 画布切换。Harness loader采用公开组件契约替身，真实主题与浏览器焦点留待用户258–260；视频继续255–257。全量与双构建、包 / 安装 / 实际preload及两库身份以 `dsh-canvas-0.2.62.manifest.json`最终记录为准，检查未通过不安装；见[ADR-0062](adr/0062-harness-node-delete-confirmation.md)。

0.2.61修复视频播放器打开后禁止节点拖动及播放器区域双指手势失效。修正前4项真实拖拽与2项手势测试复现不动；修正后视频资源、单批生成、历史收起 / 展开随1 / 2倍移动，原视频DOM / 播放时间 / 播放状态保持，按钮与定位隔离，尾随点击不误暂停。真实XYPanZoom覆盖画面 / 时间 / 按钮SVG / 进度条双轴 / 反向 / line-mode、Ctrl捏合与Meta缩放指针中心 / 边界、编辑 / 模态预览隔离与解绑；进一步复现并修正控件聚焦时拦截Meta / Control，真实useKeyPress验证按键传递，不只模拟标志。同现有音频 / 控制器 / 静态媒体UI共30项专项及最终57文件583项全量、类型、77份Markdown / 61条ADR和构建通过。双构建、同包安装 / 实际preload与两库身份最终见 `dsh-canvas-0.2.61.manifest.json`；无依赖 / Host / schema变更，人工255–257，规则更新ADR-0023 / ADR-0024。

0.2.60隐藏 React Flow 署名并将三媒体文件加载改用真实 img-fx ImageGeneration，任务保留 Beam / Orb。30项专项通过：真实组件 / shader主题参数、宿主表面色、共享GPU与帧循环、暂停 / 离屏 / 清理、无WebGL2与初始化错误，以及原图片decode / 视频首帧 / 音频波形等待和媒体DOM保持。新增5项依赖专项仅替换jsdom GPU驱动，不模拟浏览器shader编译或画质。锁定 img-fx0.5.1 / three0.186.1，生产依赖审计0项。55文件577项全量、类型、77份Markdown与61条ADR和构建通过；双构建 / 编译Host、同包安装 / 实际preload与两库身份最终见 `dsh-canvas-0.2.60.manifest.json`；人工251–254，决策见[ADR-0061](adr/0061-dependency-backed-media-pixel-loading.md)。

0.2.59将画布文字改为默认禁止选中、输入 / 可编辑 / 显式复制区域开放；作用域覆盖模型 / 参数 / @候选与公共Menu portal，画布外保持原策略。新增11项专项核对实际CSS与DOM、动态后代、名称自动全选 / Enter / Escape、忙碌提示词 / TTS、原子标签、历史复制和画布内外弹层；相关输入 / 框选 / 拖动专项32项与最终54文件572项全量通过，类型、76份Markdown / 60条ADR检查通过。jsdom不模拟真实鼠标拖选，既有输入法 / 剪贴板 / 撤销及拖拽 / 框选回归继续执行；双构建、同包安装 / 实际preload与两库身份见 `dsh-canvas-0.2.59.manifest.json`。人工验收247–250；决策见[ADR-0060](adr/0060-canvas-text-selection-opt-in.md)。

0.2.58为素材路径新增问号说明并移除虚拟素材常驻说明，沿用公开Tooltip的portal、悬停 / 聚焦与点击阅读能力。仅Client局部展示调整，不新增依赖、请求或任务；使用现有全量回归与类型 / 构建检查，安装实际preload / 两库及配置身份见 `dsh-canvas-0.2.58.manifest.json`。真实悬浮位置、主题和键盘交互由用户246验收。

0.2.57新增预审禁用原因 / 默认下一家 / 全部不可用 / 成功详情移除 / 失败原任务恢复 / 迟到配置与命名弹窗回归；原重复送审requestId与人物组分页保持，自动切供应商重置路径。Harness适配器按公开Modal / Menu / Input契约测试，宿主完整npm入口有仅平台提供的peer，不宣称原生样式或浏览器焦点通过。最终全量、双构建、包 / 实际preload与原23表 / 预审7表 / 配置身份见 `dsh-canvas-0.2.57.manifest.json`；人工验收242–245。

0.2.56新增两项操作栏原生XYPanZoom / D3平移回归：未修正时按钮不平移，修正后按钮 / SVG / 栏背景两轴分数delta、反向 / 惯性和line-mode移动画布且倍率保持；编辑器原滚动不拦截、按钮无误点击。与原四项缩放一起回归，最终全量 / 双构建 / 包 / 安装 / preload和两库身份见 `dsh-canvas-0.2.56.manifest.json`，用户241验收真实触控板行为。
0.2.55新增3项配置可用性回归、4项原生XYFlow修饰键wheel回归；三媒体历史回归补充折叠同排断言。配置尚未读取 / 未配置无入口与状态 / 组 / 提交调用；任一家配置启用已有画布且不需Group ID，失败 / 隐藏迟到保护；按钮wheel修饰键转交原生处理，浏览器默认阻止、指针与上下界保持，未误点击、未影响编辑器，销毁恢复原行为。最终全量与产物 / 本机加载结果以 `dsh-canvas-0.2.55.manifest.json`为准，不用自动化代替用户238–240视觉 / 真实触控板验收。
0.2.54预审专项32项通过：两地区官方签名精确字节 / UTC、掩码与单字段读取、主库DDL / fence、原文件hash、重复点击、本地接受 / 明确失败 / unknown、丢回执与重启不重传、分页精确唯一对账、两供应商隔离、真人项目 / 组核验，以及Asset URI / URL混用、接受后冻结、跨项目更换与缺绑定阻断。UI覆盖主图 / 历史逐输出、真实XYFlow三媒体工具栏、独立标记与媒体DOM保持、隐藏轮询 / 迟到取消、真人分页与同requestId重试。最终全量检查、双构建、编译Host / CJS SDK / 两库Worker、包 / 安装 / preload和旧23表 / 配置字节身份以 `dsh-canvas-0.2.54.manifest.json`完成记录为准。新增独立预审库，不改canvas.sqlite DDL；未调用真实账号或浏览器，用户人工验收231–237。

0.2.53新增8项服务与7项显隐UI回归，和模型卡片 / 四系列配置 / TTS / OSS共90项专项通过。覆盖掩码短值、owner单字段 / 当前Key轮换、只读 / 严格输入 / no-store、预览不写草稿、独立EP显隐、取消 / 迟到 / 替换输入 / 隐藏 / 失败重试，并移除模型设置底部说明。最终全量docs / 类型 / 测试、双构建、编译Host / 同包安装 / 实际preload、原配置字节与23表身份见 `dsh-canvas-0.2.53.manifest.json`；人工验收228–230，见[ADR-0058](adr/0058-masked-settings-and-explicit-secret-reveal.md)。

0.2.52新增11项供应商卡片 / 直接编辑回归，与原四系列配置UI共60项专项通过。覆盖五供应商、Model Link三地址合并、精确组合EP / Key修改、留空 / 取消 / 失败 / 清除、供应商限定新增、缺EP补全及焦点 / 重复提交。最终全量docs / 类型 / 测试、双构建、编译Host / 同包安装 / 实际preload、原配置字节和23表身份见 `dsh-canvas-0.2.52.manifest.json`；人工布局、主题及键盘验收224–227，见[ADR-0057](adr/0057-provider-cards-and-direct-model-editing.md)。

0.2.51验证空引用text、首连reference、手动frames / 部分移除、清空重置 / 重连及@新增引用的状态转换，覆盖同次边 / 参数保存、空草稿任务text与幂等回执。原41项Seedance协议 / 12项UI及拖动计数回归扩展；最终docs / 类型 / 全量测试、双构建、编译Host、同包安装 / 实际preload和原23表审计见 `dsh-canvas-0.2.51.manifest.json`完成记录。人工验收220–222替代215 / 217手动文生模式预期，见[ADR-0056](adr/0056-seedance-mode-inference-from-references.md)。

0.2.50 Seedance专项覆盖十二组合三模式wire请求与独立Key / EP、元数据实读、互斥输入 / 默认顺序帧角色与调整、3秒查询下限 / 临时失败、原ID重启 / 凭据轮换、视频不转发Key下载及OSS同输出恢复；UI覆盖八型号配置、菜单隐藏 / 无EP、底部模式下拉 / 图上帧标签、自动帧比例 / 角色交换 / 当前模式保持与只读混合媒体。最终全量检查、双清理构建、编译Host目录、包 / 安装 / 实际preload和全部23表 / DDL身份以 `dsh-canvas-0.2.50.manifest.json`完成记录为准。真实账户 / 模型抓取 / 编码播放由用户按214–219验收，见[ADR-0055](adr/0055-seedance-video-modes-and-independent-provider-routing.md)。

0.2.49：70份Markdown / 54条ADR、TypeScript、44个文件共424项测试与构建通过。覆盖无结果提交failed、重启修正旧unknown且不调用供应商、原外部ID查询和原OSS输出恢复、Lite配置更正保留UUID / Key / EP / 历史快照、失败SVG优先于媒体Loading且释放所有依赖循环。双构建、同包安装 / 实际preload和全部23表审计的最终身份以 `dsh-canvas-0.2.49.manifest.json` 完成记录为准。人工视觉与真实模型验收211–213，见[ADR-0054](adr/0054-no-result-submission-failure-and-seedream-id-correction.md)。

0.2.48：69份Markdown / 53条ADR、TypeScript、44个测试文件共417项测试通过。新增Seedream 28项协议 / 持久任务和11项UI回归，核对六个独立组合、官方EP / Model Link ID、原十二UUID、尺寸和参考图限制、固定EP / Key快照、实际PNG / JPEG / WebP格式及宽高、OSS保存失败重启后复用原输出、错误 / 超时不重提，以及设置EP输入和画布 / 历史 / 任务中心型号显示。原5项拖拽、13项历史只读及24项Loading回归保持。双构建、编译Host离线六组合、包 / 同包安装 / 实际preload与全部23表 / DDL / 原配置的最终身份见 `dsh-canvas-0.2.48.manifest.json`完成记录。真实账户、EP是否匹配所选型号与人工效果待206–210验收；本轮未操作浏览器或付费生成。

0.2.47全量检查通过：68份Markdown / 52条ADR、TypeScript、42个测试文件共378项测试与清理构建。相同15节点拓扑 / 60次单节点位置更新，节点data从900降到60，节点内容更新从900降到0，端点测量请求480降到0，提示词DOM同步60降到0；相同2秒轮询各项为0。新增5项回归检查最后坐标保存、实时坐标引用插入、旧任务进度仅更新所属节点、输出 / 尺寸测量以及冲突草稿保持；真实XYFlow检查固定素材边随新坐标移动。原13项历史只读、24项Loading和媒体 / 引用回归保留。双构建与安装最终状态以 `dsh-canvas-0.2.47.manifest.json`完成记录为准。仅DOM更新计数，不是绘制 / FPS测量，人工验收202–205。

0.2.46全量检查通过：67份Markdown / 51条ADR、TypeScript、41个测试文件共373项测试与清理构建。收起先关闭面板，再点击收起堆叠才挂载最新输入编辑器；图片 / 视频 / TTS、待接受任务和播放回归同步核对。双构建、同包安装 / 实际preload、完整备份和23表 / 完全不变DDL审计的最终身份见 `dsh-canvas-0.2.46.manifest.json`完成记录。用户人工验收197–201。

0.2.45全量检查通过：67份Markdown / 51条ADR、TypeScript、41个测试文件共373项测试与清理构建。新增13项回归覆盖三类媒体只读无写入 / 提交、原模型和引用、迟到响应取消、收起最新恢复 / 新任务、错误归属及待接受任务。双构建、编译Host、同包安装、实际preload与完整备份 / 23表 / 完全不变DDL审计的最终身份见 `dsh-canvas-0.2.45.manifest.json`完成记录。用户人工验收197–201，未操作浏览器或提交付费任务。

0.2.44全量检查通过：66份Markdown / 50条ADR、TypeScript、40个测试文件共360项测试与清理构建。覆盖新增提交历史、立即临时卡片与确切requestId核对、真实ReactFlow独立端点 / 收起旧边、三种媒体和逐任务Loading、同节点多个任务 / 固定快照 / 逆序完成 / 删除保护、历史音频以及旧唯一索引原子升级。双构建、编译Host、包 / 安装 / 实际preload与完整停机备份 / 23表审计的最终身份以 `dsh-canvas-0.2.44.manifest.json`完成记录为准。无存储图 / 表字段迁移，仅task_active_node唯一性变化；用户人工验收190–196，未操作浏览器或提交付费任务。

0.2.43全量检查通过：65份Markdown / 49条ADR、TypeScript、38个测试文件共336项测试与清理构建。Model Link Banana更正为generateContent的/v1路径、contents / generationConfig请求和candidates最终Base64。

2026-10-28，0.2.43：原Banana专项更新双渠道独立契约，新增6项回归检查返回字段两种拼写、thought / 其他候选过滤、安全 / 无图拒绝、缺候选 / 未完整结束、Gemini原Interactions错误分支与旧Invalid URL失败任务重启不重提；Banana34项及GPT16项专项通过。Base64实际格式 / 尺寸、OSS恢复和原UI回归保持。后续双构建 / 编译Host、包 / 安装 / 实际preload和23表 / Key / 指定失败任务保持由 `dsh-canvas-0.2.43.manifest.json`记录。真实接口生成仍由用户按186–189验收，本轮没有付费请求或浏览器操作。

0.2.42全量检查通过：64份Markdown / 48条ADR、TypeScript、38个测试文件共330项测试与清理构建。新增四款Nano Banana × 两渠道八组合及原生Base64图片保存。

2026-10-28，0.2.42：新增28项接入 / 9项UI回归，覆盖正式模型ID、独立Header与相同JSON、参考顺序与512档位、MIME / 超限 / 无效状态、真实JPEG / WebP尺寸、Key快照、OSS保存失败重启后复用暂存、DDL保持，以及配置 / 单渠道可见性与按型号参数。旧Mock目录断言更新为完整内置目录，原GPT / TTS / Loading回归通过。后续双构建、编译Host目录烟测、包 / 同包安装 / 实际preload与23表 / 配置保持由 `dsh-canvas-0.2.42.manifest.json`记录；没有真实付费调用或浏览器操作，用户按181–185验收，供应商线上兼容仍待真实账户联调。

0.2.41全量检查通过：63份Markdown / 47条ADR、TypeScript、36个测试文件共293项测试与清理构建。中央动画按屏幕DPR × 实际画布倍率增加真实像素，保留依赖引擎和设计尺寸。

2026-10-28，0.2.41：新增6项真实Orb / XYFlow密度回归，验证2.5倍 / DPR2下320×320 backing与5倍绘图变换、小数档位 / 平移不重绘、compact节点引用与独立预览、换屏 / DPR媒体查询重监听、暂停仍零依赖动画帧和共享订阅释放；4项补丁回归检查干净安装、幂等、未知版本 / 内容拒绝与引擎保持。原主题、图片解码、媒体DOM与音频交互回归保持。后续双构建、编译Host、包 / 同包安装 / HTTP实际preload和业务 / 配置保持由 `dsh-canvas-0.2.41.manifest.json`记录；未操作浏览器或提交生成任务，用户按179–180验收实际清晰度与性能。

0.2.40全量检查通过：62份Markdown / 46条ADR、TypeScript、35个测试文件共283项测试与清理构建。所有节点任务与媒体加载共用真实Beam / Thinking Orbs依赖，采用不同样式，无可见状态文字。

2026-10-28，0.2.40：18项专项覆盖12种节点分支、执行 / 警告 / 结束状态、宿主主题优先于系统与墨色变化、隐藏 / 离屏 / 减少动态效果、pulse JS循环释放、任务成功到图片decode完成的连续过渡、旧资产链接与decode回调失效、视频首帧、音频元数据 / 波形失败边界，以及媒体DOM与图读取保持。静态渲染与既有音频拖动 / 轮询测试通过。交付继续要求双清理构建、编译Host隔离启动、同包安装 / 认证HTTP / 实际preload及原业务与配置身份核验，具体身份结果以 `dsh-canvas-0.2.40.manifest.json`为准。未操作浏览器或触发付费任务；用户按175–178验收视觉、主题、媒体与VoiceOver / 键盘，WCAG 2.2 AA仅为目标，无达标声明。

0.2.39全量检查通过：61份Markdown / 45条ADR、TypeScript、34个测试文件共265项测试与清理构建。波形JSON改为认证同源200，比例菜单统一排序到21:9，原23种尺寸保持。

2026-10-28，0.2.39：12项波形回归覆盖真实解码、200 / HEAD、OSS读取合并 / TTL / 定位失效、损坏JSON / 字节超限 / 身份改变、32并发与关闭取消；四个模型组合的控件验证十种比例顺序、参数允许项、默认值与4K回退保持，无25:9或9:25。既有TTS测试改为同源波形断言；Mock结束等待包含Runtime清理完成，消除过早核对暂存的时序竞争。最终双构建、编译Host离线波形限额分支、包 / 安装 / 认证HTTP与实际preload身份由 `dsh-canvas-0.2.39.manifest.json`记录。真实浏览器波形、播放和菜单由用户按173–174验收，不触发真实付费生成。

0.2.38全量检查通过：60份Markdown / 44条ADR、TypeScript、34个测试文件共255项测试与清理构建；真实模型和浏览器验收仍由用户完成。

2026-10-28，0.2.38：新增1K宽屏合法预设、统一21:9标签，共23个能力组合；29项图片专项通过。四个模型 / 供应商组合逐一核对1280x720 / 720x1280 / 1344x576的纯文本JSON和参考multipart，原认证 / 字段保持；两款模型的实际参数控件核对1K按钮、title / 摘要、三档比例保持及数量 / 背景 / 画质不丢失。旧2048x880与3840x1648按21:9读取，不改持久size。最终全量检查 / 双构建 / 包 / 本机HTTP及preload身份见 `dsh-canvas-0.2.38.manifest.json`；未操作浏览器或付费生成，用户按170–172验收真实效果。

0.2.37交付前全量检查：59份Markdown / 43条ADR、TypeScript、34个测试文件共249项测试及清理构建通过。真实OSS与浏览器不在此检查结果内。

2026-10-28，0.2.37：按已批准方案实现Host-only ali-oss 6.23.0、单活动提供商与凭据版本、schema 3对象定位、OSS上传 / Copy / 派生、批量URL缓存和Runtime执行前参考准备。专项回归覆盖空配置创建拦截、旧schema拒绝不删除、Endpoint / 前缀校验、探测失败 / CAS保留旧配置、目标固定、历史读取轮换、发布成功DB ACK失败恢复、命名搬移保留任务引用、准备失败无付费请求、OSS故障后只发布暂存不重下载或提交、100项批量 / 跨画布归属、过期与本地V4签名。Client覆盖统一标签与两个创建入口、缓存合并 / 失效及迟到回包。编译Host烟测先验证无配置409，再仅在隔离DB离线植入测试存储，核对配置后创建 / 图 / TTS与19路由，不连接真实OSS。最终检查、双构建、包 / 安装 / 认证加载与限定历史清理身份见 `dsh-canvas-0.2.37.manifest.json`；真实Bucket / CORS / 媒体 / 模型及浏览器待用户按[清单](manual-tests.md)162–169验收。

2026-10-28，0.2.36：节点编辑卡片只按节点 / 实际尺寸 / viewport计算固定宽度锚点，去掉窗口与卡片测量和边界夹紧，取消整体viewport高度上限。图片 / 视频 / 音频NodeToolbar覆盖SDK选中节点提升层级，固定控件层级高于附件。新增布局 / DOM回归遍历三种生成卡片越界、窗口缩小、内容增长、pan / zoom与负坐标，并核对资源上方定位参数、固定层级及输入不变。补充完整图片 / 视频编辑卡片无模型回归：新节点、旧真实 / Mock选择均精确提示“请前往设置页面配置模型”，不填充最少一项，不改写原值且生成禁用。最终全量检查 / 双构建 / 包 / 本机加载以 `dsh-canvas-0.2.36.manifest.json`为准；未操作浏览器，用户按[清单](manual-tests.md)158–161验收实际遮挡、点击与空态。

2026-10-27，0.2.35：FishTTS节点读取独立Key资格并显示未配置 / 加载 / 失败状态，禁用无资格生成但保留草稿；配置保存 / 画布恢复重新读取，过时请求忽略。Host同时校验记录与Key，拦截空Key / 清除Key新任务。新增节点UI状态切换、真实画布配置传递 / 恢复，以及新请求拒绝但原已接受任务继续用旧Key恢复的回归；旧有效提交 fixture补齐密钥。最终检查 / 双构建 / 包 / 实际加载身份见 `dsh-canvas-0.2.35.manifest.json`，不调用真实付费服务或自动浏览器，人工清单157。

2026-10-27，0.2.34：按用户纠正把可见性从模型组级改为具体供应商组合级，只有有Key且非Mock的记录进入菜单；去掉“未配置”渲染分支。原截图回归改为参数化遍历仅Model Link / 仅OpenAI，每种只显示一项；新增清除当前渠道后只保留另一个已配置渠道且不自动改选择的回归。ADR-0040明确该规则并替代0039，配置表单完整目录保持。最终完整检查 / 双构建 / 包 / 安装身份见 `dsh-canvas-0.2.34.manifest.json`；未操作浏览器或发起付费任务，用户按[清单](manual-tests.md)154–156验收。

2026-10-27，0.2.33：画布只展示有至少一个供应商配置的真实模型，移除Mock候选 / 后备项；无配置时直接显示精确提示并禁用空选择器。新增3项实际UI回归覆盖截图场景、旧Mock选中值、最后一个Key清除、动态空态、任意Mock都不能填充零配置列表与输入保持。新节点默认选有Key的渠道，不改写旧节点；原Host历史恢复测试保留。完整检查 / 双构建 / 包 / 本机加载身份见 `dsh-canvas-0.2.33.manifest.json`，未调用真实付费模型或操作浏览器，用户按[清单](manual-tests.md)154–155验收。

2026-10-27，0.2.32：删除图片与FishTTS配置概览行按钮，只有右上角“配置模型”入口可以打开表单。调整原配置 / 清除回归走顶部入口，已有密钥保留测试同时核对图片与TTS行无按钮。最终检查 / 双构建 / 包 / 本机加载身份见 `dsh-canvas-0.2.32.manifest.json`；原模型协议与存储不变，未操作浏览器，用户按[清单](manual-tests.md)151验收。

2026-10-27，0.2.31：按用户反馈将设置页改为已配置模型概览，同模型渠道合并；新增 / 编辑统一先选择模型后选择供应商，FishTTS走相同入口。新增3项UI回归覆盖空态、TTS单渠道、选择切换清空未保存密钥、精确供应商保存与清除后保留其他渠道；原配置测试改为检查汇总与选择流程。按官方文档固定TTS的model Header为s1，测试同时核对Header与Body并保留原凭据 / 任务 / 音频恢复回归。53份Markdown / 38条ADR、TypeScript、211项测试及构建通过；双构建、包与本机安装身份以 `dsh-canvas-0.2.31.manifest.json`为准。未调用真实付费接口或操作浏览器，用户按[清单](manual-tests.md)151–153验收。

2026-10-27，0.2.30：接入GPT Image 2.5 Sunburst / Flare双供应商，固定Base / Bearer / 独立凭据、中文参数枚举与20种有效尺寸预设；无参考JSON / 16图multipart均按同一契约请求。新增12项Host接入 / 尺寸 / 结果 / 恢复测试和3项UI契约回归，旧Mock测试改为检查目录占位与内置真实模型。覆盖请求中断后继续、幂等原任务、密钥版本固定、部分结果失败保留、单份保存失败继续其他份并重试原描述、未配置拒绝与DDL保持。TTS固定新设置地址，原任务与凭据版本保持。52份Markdown / 37条ADR、TypeScript、208项测试及构建通过；双构建 / 编译Host / 包 / 安装 / preload身份以 `dsh-canvas-0.2.30.manifest.json` 为准；实际账户与浏览器验收仍由用户按[清单](manual-tests.md)146–150执行，本轮未调用真实付费接口。

2026-10-27，0.2.29：用户反馈0.2.28的蓝色亮段静止；原CSS终点calc求值为无单位number，新增位移回归在旧样式下失败。修正为明确px长度的固定起终点，尾迹0→-33.333333px、亮芯-1.6→-34.933333px；两层按2.3秒线性循环推进一个dash周期，方向 / 相位不变。2项新检查读取实际CSS，验证终点长度类型、正向流动对应的负offset、周期连续性；原6项关系与全部交互回归保持。51份Markdown / 36条ADR、TypeScript、193项测试及构建通过。仅样式修正，不新增逐帧更新 / 依赖 / API / 持久字段。双构建、编译Host、包 / 本机安装和实际preload身份以 `dsh-canvas-0.2.29.manifest.json`为准。未操作浏览器，实际连续运动与顺滑度由用户按[清单](manual-tests.md)145验收，CSS值检查不等于浏览器动画测量。

2026-10-27，0.2.28：新增单选直接入出边蓝色流光，使用source-to-target的Bezier路径、归一化CSS亮段与最后绘制的EdgeText；原BaseEdge选择 / 删除热区、标签和标记保留，选中连线样式只作用主路径。无逐帧React更新、滤镜或持久字段。新增6项回归覆盖直接关系 / 不相关对象复用 / 原图不变、左右两种几何与标签 / 标记 / 热区、单选切换 / 多选 / 清空、侧栏 / 页面隐藏恢复及真实框选取消；原音频 / 播放 / 缩放 / 框选回归保持。51份Markdown / 36条ADR、TypeScript、191项测试、PostCSS解析及构建通过。17路由、Host、依赖、DDL与数据格式不变；双构建 / 编译Host / 包 / 本机安装与实际preload身份以 `dsh-canvas-0.2.28.manifest.json`为准。未操作浏览器，用户按[手动清单](manual-tests.md)142–144验收真实流光、方向、缩放和减少动态效果。

2026-10-27，0.2.27：修正整个AudioPlayer的nodrag和底部整行pointerdown拦截，时间与留白恢复节点拖动 / 点击选择，只在波形及播放按钮隔离节点拖动；整个播放器保留nopan，以原生XYFlow过滤器隔离鼠标画布平移 / 双击缩放，专用wheel处理不变。新增2项实际XYFlow / D3拖拽回归覆盖普通音频和TTS结果、1 / 2倍率、波形加载前后的时间 / 空白位移、播放进度不变、按钮 / 波形不移节点、播放及普通点击边界；扩展原轮滚回归，直接验证原生D3双击后viewport不变。最终50份Markdown / 35条ADR、TypeScript、185项测试、PostCSS解析及构建通过；初始未安装候选因新增原生双击回归失败撤回并存于受限临时目录，修正后重新全量验证，未操作原安装。17路由、Host、依赖、DDL及存储身份保持；双构建 / 编译Host / 包 / 安装与实际preload身份按 `dsh-canvas-0.2.27.manifest.json`记录。未操作浏览器，用户按[手动清单](manual-tests.md)141验收真实拖动 / 播放 / 定位。

2026-10-27，0.2.26：按用户真实宿主截图定位原生Input内层width=100%叠加padding导致越界，修正UiInput原生两层border-box；搜索、分页与表格列设定固定基准尺寸，窄窗换行 / 表格内横向滚动；任务ID前16位省略显示并增加左侧完整ID复制。50份Markdown / 35条ADR、TypeScript、183项测试、PostCSS解析及构建通过；新增3项覆盖完整ID复制 / 成功反馈 / 不触发查询详情、剪贴板拒绝时Modal内选择复制 / 清理 / 恢复焦点及草稿、两条路径失败的真实错误反馈。原180项回归保持，未新增镜像CSS断言。Host、17路由、依赖、DDL与存储格式不变；双构建 / 编译Host / 包 / 实际安装和preload身份按 `dsh-canvas-0.2.26.manifest.json`记录。未操作浏览器，真实间距、列宽、缩略和剪贴板权限由用户按[手动清单](manual-tests.md)139–140验收。

2026-10-27，0.2.25：任务弹窗新增owner范围只读task-search、八列目录表格、全条件AND查询、双月日期时间范围与通用分页、可返回详情。50份Markdown / 35条ADR、TypeScript、180项测试及构建通过；新增11项涵盖SQL联合筛选 / 字面模糊 / owner与删除范围 / 时间端点 / 页码钳制 / 插入上限、日期有效性 / 单侧 / 草稿 / Escape / 键盘、显式查询 / 过期响应 / 跨画布详情返回。SQLite DDL、旧图和旧task接口不变，目录不返回私有快照 / Key。双构建、编译Host的17路由冒烟、包 / 安装 / 实际preload身份按 `dsh-canvas-0.2.25.manifest.json`记录；安装核验为独立门槛。未操作浏览器，实际主题 / 时间层 / 表格 / 返回与分页由用户按[手动清单](manual-tests.md)134–138验收。

2026-10-27，0.2.24：底部“添加节点”菜单按钮间距从4px调为14px，上移约10px。通过公开 `Menu.getAnchorRect` 供宿主跟随定位并保留视口限制，独立开发菜单使用同一gap；其他操作菜单默认不变。49份Markdown / 34条ADR、TypeScript、169项现有测试、CSS解析与构建通过，未增加镜像样式测试。双构建 / 编译Host / 包 / 安装及实际preload身份按 `dsh-canvas-0.2.24.manifest.json`记录；独立Terminal驻留启动，未操作浏览器，真实菜单间距与关闭 / 添加交互由用户按[手动清单](manual-tests.md)133验收。

2026-10-27，0.2.23：接入对话右侧画布标签，见[ADR-0034](adr/0034-conversation-sidebar-canvas.md)。49份Markdown / 34条ADR、TypeScript、169项测试、CSS解析与构建通过。新增5项回归覆盖公开两阶段注册 / 延迟插槽 / 清理 / 共享API、真实CanvasApp项目与目录保留、隐藏轮询暂停 / 草稿自动保存，以及音频资源和TTS结果隐藏停止 / DOM保留 / 返回不重载或重播 / 对话键盘隔离。Host、API、SQLite与既有图数据无变化；双构建 / 编译Host / 包 / 实际安装和client preload以 `dsh-canvas-0.2.23.manifest.json`核验记录为准。未操作浏览器；真实侧栏开启、切换 / 停靠、窄宽布局及多入口保存冲突由用户按[手动清单](manual-tests.md)129–132验收。

2026-10-27，0.2.22：左侧缩放 / 定位按钮组下移，与中间悬浮工具栏共用27px底部间距；覆盖原生面板margin-bottom，保留横向位置与事件。仅[样式](../src/client/styles.css)变化，不新增镜像样式测试。48份Markdown / 33条ADR、TypeScript、164项测试、CSS解析和构建通过。双构建 / 编译Host / 包 / 本机加载身份使用 `dsh-canvas-0.2.22.manifest.json`；未操作浏览器，实际底边对齐与按钮交互由用户按[手动清单](manual-tests.md)128验收。

2026-10-27，0.2.21：透明框选与严格几何选择见[ADR-0033](adr/0033-strict-marquee-selection.md)。48份Markdown / 33条ADR、TypeScript、164项测试、CSS解析和构建通过。新增8项[实际Pane回归](../tests/marqueeSelection.test.tsx)，真实ReactFlow与库getNodesInside直接复现未测量 / 屏幕外节点旁路，再覆盖缩小 / 空选择 / 无图保存、完整包含与最终松手位置、非零容器偏移 / 小数缩放 / 反向拖动、旧选择替换 / Shift基线、取消 / 失焦恢复、资源 / 音频Portal / 结果操作DOM / 编辑器以及过程框与分组透明样式。仅布局 / 媒体浏览器设施替代，选择算法未mock。原156项回归保持；不改变Host、数据库、媒体与任务。双构建 / 编译Host / 包 / 本机加载身份使用 `dsh-canvas-0.2.21.manifest.json`；未操作浏览器，实际鼠标 / 触控板与视觉由用户按[手动清单](manual-tests.md)124–127验收。

2026-10-27，0.2.20：针对放大后文字 / 矢量发虚的截图，撤销永久视口will-change / 3D提示，改为仅硬件允许的固定倍率平移短暂合成；缩放及静止释放，TTS改为灰色内联SVG，见[ADR-0032](adr/0032-scale-aware-viewport-compositing.md)。47份Markdown / 32条ADR、TypeScript、156项测试、CSS解析和构建通过。新增5项[合成状态回归](../tests/viewportCompositing.test.tsx)验证倍率首帧撤销、混合手势 / 小数缩放 / 200ms、隐藏 / 失焦 / 回退 / 销毁、CSS状态映射、实际React Flow Store订阅且不逐帧React渲染、不重挂媒体或覆盖inline transform；原GPU探测、TTS徽章 / 仅输出、音频与原151项回归保持。Host / 图 / 数据不变。双构建 / 编译Host / 包 / 真实加载身份使用 `dsh-canvas-0.2.20.manifest.json`；未操作浏览器，缓存为截图与代码支持的原因假设，实际清晰度 / 图层 / 性能由用户按[手动清单](manual-tests.md)122–123对比。

2026-10-27，0.2.19：TTS情绪文字徽章与单色极简空态见[ADR-0031](adr/0031-tts-emotion-badges-and-monochrome-nodes.md)。46份Markdown / 31条ADR、TypeScript、151项测试、CSS解析和构建通过。[TTS编辑](../tests/ttsUi.test.tsx)新增3项并更新原测试，覆盖已保存原值自动中文徽章、不触发改写、未知括号 / 原子删除 / 撤销、纯文本复制 / 剪切 / 安全粘贴、portal光标与后文保留、仅单色图标 / 320×180 / 仅输出；原[素材编辑](../tests/promptEditor.test.ts)、[受控@组件](../tests/mentionPromptEditor.test.tsx)及TTS生成结果播放回归保持。数据与请求仍为(calm)等原值，无迁移 / 新请求；双构建 / 编译Host / 包 / 本机加载身份记录使用 `dsh-canvas-0.2.19.manifest.json`。实际徽章基线、图标颜色和输入法由用户按[手动清单](manual-tests.md)120–121验收，未操作浏览器。

2026-10-27，0.2.18：新增FishTTS节点、情绪原始标签、计数器和全局服务凭据，见[ADR-0030](adr/0030-fish-tts-nodes-and-streamed-audio.md)。45份Markdown / 30条ADR、TypeScript、148项测试、CSS解析和构建通过。新增14项[服务](../tests/tts.test.ts)、[控件 / 设置](../tests/ttsUi.test.tsx)和[实际画布播放](../tests/audioCanvasPlayback.test.tsx)回归，覆盖完整payload / 音频流 / 原字节 / 波形、入边拒绝、缺配置 / 空文字 / 错路由、hash增量 / 保留音色草稿 / 提交trim、DDL不变 / 重开、Key轮换 / 原地址恢复、401 / 503脱敏与不重提、同结果保存、大小 / 类型拒绝 / 临时字节清理、中文 / 英文 / IME / 光标 / 键盘、计数器、无模型 / 仅输出 / 生成结果持续播放。原134项回归保持。双构建、编译Host、包 / 实际安装与加载身份由 `dsh-canvas-0.2.18.manifest.json`记录；真实账户 / 音色 / 情绪效果与浏览器视觉未验收，用户按[手动清单](manual-tests.md)115–119核对。未自动发起真实生成。

2026-10-27，0.2.17：通用生成参数滑块与音频滚动透传见[ADR-0029](adr/0029-generation-sliders-and-audio-wheel.md)。44份Markdown / 29条ADR、TypeScript、134项测试、CSS语法与构建通过。新增11项[滑块](../tests/sliders.test.tsx)、[Mock流水线](../tests/mockGeneration.test.ts)和[真实DOM滚动](../tests/audioWheel.test.tsx)回归，覆盖1–10数量、非等距固定时长 / 区间 / 步长 / 键盘 / ARIA / 禁用，10个独立图片 / 视频有序保存、第10个主图 / 重开、0秒草稿和提交拒绝，以及音频加载 / 波形 / 按钮 / 时间上的XYFlow双轴平移；[生成组](../tests/generationGroup.test.tsx)扩展10结果，原播放 / 游标回归保持。n校验上限放宽、secondsRange只派生能力，不改变图 / 快照字段、21表DDL或原媒体。交付身份记录使用 `dsh-canvas-0.2.17.manifest.json`；人工滑块与触控板验收见[手动清单](manual-tests.md)113–114。

2026-10-27，0.2.16：音频游标从低频timeupdate改为帧同步实际currentTime，仅直接更新当前SVG游标和新跨过的条，不每帧更新React / 画布。43份Markdown / 28条ADR、TypeScript、123项测试与构建通过。新增5项[帧回归](../tests/audioPlayhead.test.tsx)：无timeupdate仍前进、时钟停顿不假移动、单帧循环、暂停 / seek / 缓冲 / 结束、隐藏 / 错误 / 销毁、倒退 / 归一化边界，以及无逐帧React重绘和旧时间属性不回拉游标；原持续播放 / 切换回归保留。依赖、Host、图 / 任务 / 原媒体不变。双构建 / 包 / 安装身份记于 `dsh-canvas-0.2.16.manifest.json`；实际顺滑度由用户按[手动清单](manual-tests.md)112验收。

2026-10-26，0.2.15：修复音频播放按钮未同步选中节点，导致画布选择规则立即暂停的问题；同一更新选中节点、清除边选择并设置播放身份，数据 / 波形 / Host不变。43份Markdown / 28条ADR、TypeScript、118项测试与构建通过。新增2项[画布播放回归](../tests/audioCanvasPlayback.test.tsx)，先在修复前复现立即暂停，再核对实际Workspace → AudioNode → AudioPlayer的持续播放 / 时间推进、暂停、两音频切换、空白停止和结束重播；只替换画布布局与原生媒体方法，不复写选择策略。双构建 / 包 / 安装身份记于 `dsh-canvas-0.2.15.manifest.json`；浏览器听感由用户按[手动清单](manual-tests.md)111验收。

2026-10-26，0.2.14：真实音频波形卡片、自定义定位播放与紧凑提示词 / 等高徽章 / 末行控制见[ADR-0028](adr/0028-audio-waveforms-and-compact-prompts.md)。43份Markdown / 28条ADR、TypeScript、116项测试、CSS解析与构建通过。新增12项[波形测试](../tests/waveforms.test.ts)和[音频 / 编辑器交互](../tests/audioUi.test.tsx)：真实反相立体声WAV、强弱 / 静音 / 时长、PCM分片 / 压缩、并发 / HEAD / 权限 / 原字节 / DTO / DDL、格式 / 版本 / 归属 / 路径 / 停止；高亮游标、拖动 / 键盘、卸载后迟到结果、仅输出端点 / 固定尺寸，以及两类生成卡片以控制行收尾。波形复用现有ffmpeg，运行依赖 / 21表DDL不变；恢复声明既有jsdom开发测试依赖。双构建 / 包 / 安装身份记于 `dsh-canvas-0.2.14.manifest.json`；未操作浏览器，用户按[手动清单](manual-tests.md)107–110验收。

2026-10-26，0.2.13：生图 / 生视频共享@提示词编辑器，合法候选自动连线、具体素材UUID标签与任务编号解析见[ADR-0027](adr/0027-prompt-asset-mentions.md)。42份Markdown / 27条ADR、TypeScript、104项测试、CSS解析与构建通过。新增18项领域 / DOM / 受控React / Mock链路测试，覆盖光标、多行 / emoji、中文组合、纯文本剪贴板、原子删除 / 撤销、失效引用 / 环 / 能力 / 主图、parent echo与body portal、候选滚动；真实协议替身检查附件与编号提示词一致。运行依赖与21表DDL / DTO不变，仅增加jsdom开发测试依赖。继续本地Mock，无真实生成请求；双构建 / 包 / 安装身份记于 `dsh-canvas-0.2.13.manifest.json`。未操作浏览器，用户按[手动清单](manual-tests.md)102–106验收。

2026-10-26，0.2.12：生成编辑卡片首排上传操作、第二排已连接参考图；图片 / 视频共用布局，各排独立换行。41份Markdown / 26条ADR、TypeScript、86项现有测试、CSS解析和构建通过。本轮仅布局，无新增业务测试；Host、数据、引用绑定和任务行为保持。双构建 / 包 / 安装身份记于 `dsh-canvas-0.2.12.manifest.json`，浏览器两排效果由用户按[手动清单](manual-tests.md)101验收。

2026-10-26，0.2.11：根据用户截图调整媒体外框、SVG圆圈加号、主图专属端点、固定收起位置和展开隐藏编辑，见[ADR-0026](adr/0026-primary-only-group-interaction.md)。41份Markdown / 26条ADR、TypeScript、86项测试、CSS解析和构建通过。新增4项[分组回归](../tests/generationGroup.test.tsx)遍历图片 / 视频、2 / 3 / 4份与每个主图位置，检查只有主图一对端点、左下收起不移动、编辑卡片开关和正方形SVG中心圆；[Mock测试](../tests/mockGeneration.test.ts)更新为新连线仅主图、旧边不改绑。Host、依赖和存量数据结构不变；双构建 / 包 / 安装身份记于 `dsh-canvas-0.2.11.manifest.json`。未操作浏览器，用户按95–100完成实际视觉与交互验收。

2026-10-26，0.2.10：简洁生成节点、动态参数弹层、图片 / 视频分组主图和本地Mock见[ADR-0025](adr/0025-generation-groups-and-local-mock.md)。40份Markdown / 25条ADR、TypeScript、82项测试、CSS解析和构建通过。新增7项[Mock测试](../tests/mockGeneration.test.ts)：mock-generate返回202摘要、无fetch / 无凭据或外部完成标记、多PNG可解码 / 差异、真实MP4解码、参数 / CAS / 幂等拒绝、重启主图身份保留、保存失败复用暂存结果、展开具体素材绑定与几何。存量21表DDL和图 / 任务DTO不变，视频样例尺寸 / 时长复用现有资产字段。双构建 / 包 / 安装身份记于 `dsh-canvas-0.2.10.manifest.json`。当前UI仅Mock，未调用浏览器；参考样式、分组交互与焦点由用户按92–99验收。

2026-10-26，0.2.9：自定义有声视频控制与无外框原媒体预览见[ADR-0024](adr/0024-custom-video-and-chromeless-preview.md)。39份Markdown / 24条ADR、TypeScript、75项测试及构建通过，PostCSS样式解析通过。新增12项[播放控制器测试](../tests/videoPlayback.test.ts)，覆盖声音开启、媒体事件、时间 / 定位边界、未知时长、自动播放拒绝 / 恢复、解码错误与关闭后的迟到Promise；3项[静态UI检查](../tests/mediaUi.test.tsx)核对节点 / 预览无native controls或muted、最小控件、官方headless参数、单关闭按钮与开发dialog语义。双构建 / 包 / 安装身份记于 `dsh-canvas-0.2.9.manifest.json`；没有操作浏览器，截图效果、真实有声播放和焦点验收由用户按88–91完成。

2026-10-26，0.2.8：普通滚轮 / 双指移动改为平移，Command / Ctrl加滚轮缩放，见[ADR-0023](adr/0023-canvas-wheel-and-trackpad-gestures.md)。38份Markdown / 23条ADR、TypeScript、60项测试及构建通过；新增[原生wheel测试](../tests/gestures.test.ts)9项，驱动实际XYFlow / D3核对上下 / 双轴 / 惯性平移、空格、两种修饰键、指针中心 / 最小缩放、捏合、line-mode和nowheel控件隔离。依赖与存量数据结构不变；双构建 / 包 / 安装身份记于 `dsh-canvas-0.2.8.manifest.json`。未调用浏览器，真实键盘订阅、框选、触控板与鼠标交互由用户按83–87验收。

2026-10-26，0.2.7：增加资源画面双击后的画布聚焦放大，适应单个节点当前测量尺寸并沿用缩放边界；在捕获阶段处理资源双击，避免React Flow原生双击缩放叠加。名称改名、顶部原文件预览、视频单击播放和存量数据保持原规则。37份Markdown / 22条ADR、TypeScript、51项现有测试及构建通过；双构建 / 包 / 安装身份记于 `dsh-canvas-0.2.7.manifest.json`。此次没有新增业务测试或调用浏览器；事件交互和参考图效果由用户按清单81–82验收。

2026-10-26，0.2.6：纯媒体节点、独立压缩封面与曲线连线见[ADR-0022](adr/0022-media-covers-and-curved-edges.md)。37份Markdown / 22条ADR、TypeScript、51项测试及清理构建通过。新增[封面测试](../tests/previews.test.ts)6项使用真实sharp生成EXIF旋转JPEG、真实ffmpeg生成首红后蓝MP4，检查尺寸、第一帧颜色、原字节 / 图 / 表数不变、并发缓存、Range/HEAD与归属 / symlink拒绝；另覆盖原生图片转换中停止服务，不触发未捕获stream error、不发布封面。生产依赖审计0项；产物 / 包 / 安装身份继续由当前管线写入 `dsh-canvas-0.2.6.manifest.json`，不代表浏览器视觉已验收。

2026-10-26，0.2.5：增加每轮自动更新与压缩包清理规则，新增AGENTS入口，并将其纳入文档检查和源码身份清单。36份Markdown / 21条ADR、TypeScript、45个现有测试及构建通过；双构建 / 编译Host隔离启动 / 包内hash沿用原管线，身份写入 `dsh-canvas-0.2.5.manifest.json`。本次未修改运行时功能。

先核对0.2.4源码 / 安装版本及当前包hash，再删除0.1.0至0.2.3的五个旧tgz；完成本轮本机更新核验后，清理被替代的0.2.4包。压缩包只留最新已核验版本，历史manifest保留作为证据，不代表旧tgz仍可取得，见[ADR-0021](adr/0021-local-update-and-package-retention.md)。

2026-10-26，0.2.4：画布目录改为固定300px卡片 / 20px间距的自动网格，保留现有字段及官方操作菜单。TypeScript、45个现有测试、34份Markdown / 20条ADR及CSS解析通过。CSS列数规则核对940px容纳3列、1260px容纳4列，少量卡片不拉伸；不足300px时收窄。此处是布局规则检查，不代表浏览器截图或实际排版已验收；用户按手动清单72–73确认。

双清理构建、编译Host隔离启动与包内hash继续沿用既有管线；产物身份记于根目录 `dsh-canvas-0.2.4.manifest.json`。本次仅修改客户端呈现，更新前后通过公开API比对目录、模型和存储设置。

2026-10-26，0.2.3：接入 Harness 官方 UI primitives，并以官方 Button / Menu 组合单选，替换设置、编辑器与列表常规操作组件。TypeScript、45个现有测试、34份Markdown / 20条ADR和生产依赖审计0项通过。组件封装静态渲染核对两处入口、宿主 / 独立开发分支、输入属性、数字选项转字符串、按钮 type 和弹窗 / 菜单组合；宿主组件使用契约替身，未将此检查当作官方组件浏览器交互实测。

官方公开包只作为固定开发依赖，浏览器构建 external 交给宿主共享。0.2.3继续使用双清理构建 / lib hash、编译Host隔离启动和包内hash管线；产物身份写入根目录 `dsh-canvas-0.2.3.manifest.json`。菜单方向键 / Escape、焦点回归、弹窗层级、边缘定位和主题视觉见手动清单68–71。

2026-10-26，0.2.2：设置页名称 / 原生卡片与表单 / 宿主主题继承通过 TypeScript、45个现有测试和文档检查（33份Markdown / 19条ADR）。PostCSS解析样式，并对照已安装Harness `0.2.1-rc.2` 的官方主题bundle核对全部宿主变量名称；背景、文字、主按钮、边框、网格、强调色在浅 / 深色中均解析为不同的官方色值，自定义强调色覆盖也被继承。React静态渲染包含新名称、图片 / 视频标签、空态和添加入口；默认项目列表仍正确。此检查没有调用真实模型或浏览器，不代表截图视觉验收已完成。

0.2.2产物身份由 [verify-artifact.mjs](../scripts/verify-artifact.mjs) 写入根目录 `dsh-canvas-0.2.2.manifest.json`；双构建、编译Host隔离启动与包内hash核验仍按同一发布管线执行。手动清单新增65–67，覆盖窄设置区域、全插件主题切换、跟随系统 / 固定主题以及输入和图状态保留。

2026-10-26，0.2.1：项目列表 / 编辑器导航调整通过 TypeScript、45 个现有测试（服务20、SQLite11、GPU14）和文档检查（32份Markdown / 18条ADR）。两次清理构建28份lib文件SHA-256一致；编译后的Host / Worker / schema在系统临时目录启动、创建画布及注册 / 清理13个路由通过。未启动或迁移用户真实数据。

一次内存构建后使用 React 服务端渲染检查默认 `CanvasApp`：输出包含“画布项目”及列表加载态，没有画布区域、旧目录条或项目下拉框，初始渲染不调用图 / 模型 API。该检查只覆盖默认渲染，不代替点击、保存、菜单和浏览器布局验收。

0.2.1 lib集合hash：`78f3c985a1238c5771990e6a18fcd2abc978793ee89a2a409e4dc9d3677e1eb2`。输入 / 单文件hash由 [verify-artifact.mjs](../scripts/verify-artifact.mjs) 生成根目录 `dsh-canvas-0.2.1.manifest.json`，构建比较与隔离运行的中间文件位于系统临时目录。安装包另核对包内版本、运行文件hash及文档内容，构建身份不代表真实Harness UI已验收。

历史0.2.0存储实施：锁定安装后的31份Markdown / 17条ADR、TypeScript、45个测试、27份lib双构建及编译Host隔离启动通过；lib集合hash `aff4f6d8627a8cfce7990031c3c35520fab1ca8e279852b187690cf1e044dcbb`，原清单保留为 `dsh-canvas-0.2.0.manifest.json`。

| 范围 | 可追溯证据 |
| --- | --- |
| 增量 / 事务 | [sqlite.test](../tests/sqlite.test.ts)：改变行、no-op、用户 / 后台 hash 链、重复 ACK 原回执、hash / revision / request冲突、FK / CAS回滚、跨画布FK、writer token fence |
| 目录 / 上传 | 一级目录唯一与请求幂等、非空文件夹、软删除、upload-start幂等、资源占位 / 导入成功 |
| 对象存储 / 发布 | [objectStorage.test](../tests/objectStorage.test.ts)：单目标、固定凭据 / 引用、Copy CAS、暂存身份与ACK恢复、旧schema拒绝；旧本地迁移用例为历史证据 |
| 生成 / 生命周期 | [service.test](../tests/service.test.ts)：图片 / 视频、原 Key / ID恢复、外部失败code/原因、外部完成与storage失败分离、重试保留attempt、断开请求后继续、文件发布 / 输出提交间恢复、未知提交不重提 |
| 权限 / 协议 | Key不回显 / 错误脱敏 / 空值编辑、LocalVault0600、引用格式 / 归属 / 环、stream超限 / SVG拒绝、Range、Harness有限路由与清理 |
| 提示词引用 | [promptMentions.test](../tests/promptMentions.test.ts)、[promptEditor.test](../tests/promptEditor.test.ts)、[mentionPromptEditor.test](../tests/mentionPromptEditor.test.tsx)：稳定UUID / 输入编号、无环 / 能力 / 主图、IME / caret / plain clipboard / undo、受控parent echo与portal；[Mock链路](../tests/mockGeneration.test.ts)验证图片 / 视频快照和失效拒绝 |
| GPU | [gpu.test](../tests/gpu.test.ts)：14个硬件 / 软件 / 未知 / 不支持 / 超时回退和上下文释放用例 |
| 滚轮 | [gestures.test](../tests/gestures.test.ts)：真实XYFlow / D3的普通 / 双轴 / 惯性平移、空格、Meta / Ctrl修饰键、指针中心缩放、捏合、line-mode与nowheel；键盘订阅和鼠标框选仍需人工验收 |
| 播放 / 预览 | [videoPlayback.test](../tests/videoPlayback.test.ts)、[mediaUi.test](../tests/mediaUi.test.tsx)：原生媒体事件替身、固定声音、定位 / 元数据 / 拒绝 / 销毁与迟到Promise，静态最小控件 / 官方headless / 单关闭按钮；真实编码和焦点仍需人工验收 |
| 封面 | [previews.test](../tests/previews.test.ts)：真实图片 / 视频解码、第一帧、压缩 / EXIF、原字节 / 图 / Schema兼容、并发缓存、Range / HEAD、归属 / 路径 / 错误隔离；页面旋转和播放仍由人工验收 |

这些证据不代表完整断电可靠性、真实模型费用 / 效果、目标 Harness profile 或浏览器视觉已验收。旧版曾核对隔离 Harness 认证 / lazy注册，不能自动替代新包真实加载。

## 待用户手动完成

按[手动清单](manual-tests.md)执行，记录日期、版本、Host / SDK / 浏览器、实际结果和脱敏证据：

- 真实文生图 / 图生图 / 文生视频 / 单图生视频与原 ID 恢复。
- 项目列表默认入口、点击进入 / 保存后返回、菜单 / 文件夹筛选、手机布局；添加菜单、上传拖拽 / 多文件、名称修改、目录 CRUD 与跨窗口冲突。
- 接收中断、完整接收后关页面、生成中关面板与停 / 重启 Harness。
- OSS权限 / CORS / Range、云端故障 / Copy中断、暂存ENOSPC与离线完整备份恢复。
- 键盘焦点、媒体编码可播放性、GPU实际图层 / 大图帧时间和内存。
- 原生设置页面版式；浅色 / 深色 / 跟随系统在项目列表、画布与全部弹窗中的实际显示和输入保持。

## 当前限制

| 优先级 | 限制与影响 | 控制 / 重审 |
| --- | --- | --- |
| 高 | 外部请求与SQLite不是原子事务，不能保证exactly-once或取消 | issued不明停自动重提；详情 / 外部ID供核对；[ADR-0016](adr/0016-host-runtime-task-details-and-credentials.md) |
| 高 | OSS对象 / 凭据与SQL分介质 | 固定key / hash / HEAD / CAS、旧对象保留、原Key版本；真实断电 / 云端故障仍待测 |
| 中 | 全画布 / 资产 / 生成历史常驻宿主投影，diff仍遍历图 | SQL只写变化行，但尚无大图性能成绩；超预算拆投影 / 懒载 |
| 中 | 云端上传 / Copy与首次解码耗时；OS / SDK收尾无固定上限 | OSS网络操作移出写队列，有界调度与临时解码；真实延迟 / 内存待测 |
| 中 | 旧云端对象、未完成暂存、任务 / mutations / 凭据无GC | 完成暂存清理，旧对象保留固定引用；云端空间 / 费用需预留 |
| 中 | 封面首次解码 / 平台原生依赖 | 串行32身份、超时 / 像素限额与30秒失败冷却；临时目录完成清理，真实长时负载待测 |
| 中 | Base64模型JSON、图片引用仍整体缓冲 | per-file / reference限额与并发，尚无峰值预算实测 |
| 中 | 模型JSON / 凭据绑定非跨文件事务；Host凭据备份依赖提供方 | 限制权限，先建版本再绑定；缺失版本拒绝恢复，人工完整备份 |
| 中 | 尚未下载的供应商输出URL过期无法通用刷新 | 存在暂存只重试发布；缺暂存仍依赖原描述，不重新付费生成 |
| 中 | 同步Base64结果的暂存写失败可能无法保留原输出描述 | 先保存外部完成事实，标save_failed；缺原描述 / 外部ID时重存返回RESULT_UNAVAILABLE，不盲目重提 |
| 中 | 队列限制仅生成接受态1000，不是磁盘 / 历史 / 上传总量限额 | 未设查询次数上限；容量 / 公平性尚未压测 |
| 中 | 真实Bucket / CORS / 模型抓取未验收，外发URL无法原地延长 | 用户配置后按162–168验收；URL协议默认24小时，现有multipart / data URL保持 |
| 低 | 格式签名不等于完整解码；部分尺寸 / 时长缺失 | 实际编码 / 播放人工验收 |
| 低 | 根路径URL、单owner、无跨设备同步 / 图导入 / 全批次历史浏览 | 有明确新需求再立ADR |

当前认证媒体original / preview入口返回OSS307，waveform返回同源200 JSON；业务错误在JSON catch中脱敏，页面加载失败有限刷新。旧版曾有的本地路径 / 自动导入描述仅为历史证据，当前行为以ADR-0043 / 0045和schema 3为准。

依赖审计（2026-10-28）：完整开发树仍报告5项既有问题（Vitest / mocker / tinypool与SDK自己的Zod依赖），未发现ali-oss条目。未强制升级测试主版本或改官方SDK依赖；维护者在生产使用前、最迟2026-11-02复核。只覆盖项目安装树，不代表目标Harness实际运行依赖已完整审计。

## 检查入口

`npm run docs:check`、`npm run typecheck`、`npm test`、`npm run build`；`npm run check` 串行执行全部。打包前评审和构建身份记录见[本次构建审查](release-review.md)。浏览器与真实模型验收由用户完成，本次不操作浏览器。
