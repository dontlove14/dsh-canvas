# ADR-0046：依赖实现的整节点 Loading 与宿主主题

状态：已采纳

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-28。
记录日期：2026-10-28。新增或替换插件Loading、更新动画依赖或宿主主题约定时复核。

## 背景与驱动因素

1. 用户要求任务执行中的Loading覆盖整个节点，不再仅显示左下角的小旋转图标。
2. 用户推荐[Thinking Orbs](https://github.com/Jakubantalik/thinking-orbs)，明确“动画不要自己实现，直接使用这个依赖处理”；另明确[Beam](https://libraries.dev/beam)是“给所有节点使用的 loading 的方式”。
3. 插件主题由DeepSeek Harness管理，动画不能自行跟随系统而忽略宿主显式浅色 / 深色，也不能引入独立彩虹主题。
4. 用户要求记录后续询问规则；本轮已明确指定两个依赖，无需再次询问是否使用。
5. 用户进一步要求图片加载过程和生成成功后文件尚未显示的阶段也使用Beam其他样式，节点上不显示任务状态文字；截图暴露了图片未加载时的原生图标与文件名。

## 决策

安装并锁定`thinking-orbs@0.3.2`和`border-beam@1.4.1`。所有节点共用[NodeLoading](../../src/client/NodeLoading.tsx)：Beam包住整个节点，中央使用ThinkingOrb。直接渲染两个依赖的组件，不自绘Orb、不传自定义frame、不自行实现Beam的几何或动画关键帧。应用CSS仅负责定位、主题背景、静态警告标识与暂停依赖动画；节点不显示状态文字或百分比，语义文字仅供屏幕阅读器。

0.2.41按[ADR-0047](0047-zoom-aware-loading-resolution.md)为锁定Orb增加经上游hash校验的绘图密度参数，仅随实际画布缩放提高Canvas2D像素数，不改动画引擎、设计尺寸或本ADR状态 / 主题 / 暂停约定。

图片生成、视频生成、空TTS、带结果TTS、图片 / 视频 / 音频资源及无素材节点均使用同一入口；没有任务且文件已就绪时保留原空节点图标和媒体内容。submitted / queued使用Beam `pulse-inner`与Orb `connecting`，generating用整圈`md`与`working`，saving用`pulse-outside`与`weaving`；生成成功 / 普通素材加载中用`pulse-inner`与`shaping`。unknown / save_failed用静态依赖效果与不同的警告轮廓，不持续假装执行；执行终态与本地文件就绪均满足后移除Loading并释放动画。仅视觉状态变化，不变更任务身份、图结构、尺寸、引用、结果或媒体播放器挂载。

节点边界汇总内部媒体加载状态，保持单个整节点Loading，不在图片与外层重复叠加。SignedImage在拿到当前对象链接、load与decode完成前隐藏原生img表面，避免空src / 加载 / 错误时露出图片图标或文件名；资产切换立即失效旧链接与旧decode回调。图片等解码，视频播放器等loadeddata首帧，音频等loadedmetadata与波形请求结束；波形失败保留原音频可播放路径，媒体链接 / 解码 / 播放终态错误停止等待并保留实际错误，不无限Loading。装饰结果堆叠图不阻塞主图就绪。引用图与独立预览复用加载方式，使用20px Orb适配小区域。

通过工作区内一个主题订阅读取实际宿主：优先Harness的`body[data-ds-dark-theme]`，浅色由宿主色值 / color-scheme判定，独立开发页保留深色兜底。两个组件显式接收dark / light，Orb墨色采用宿主文本计算色，Beam使用对应主题的mono配色，背景继承`--dc-surface`。观察真实祖先的主题属性和head样式变化，不观察全画布DOM或逐帧更新React。

工作区隐藏、页面隐藏、节点移出视口或系统减少动态效果时暂停；减少动态效果保留可见静态效果。Beam的pulse样式还运行依赖内JS oscillator，因此暂停时改用依赖的静态md以释放JS帧循环，恢复时回到原样式，不只暂停CSS。Loading不接收指针、不进入Tab顺序，保留拖动 / 连线与媒体控件事件，层级低于节点Handle和全局工具栏。Orb为装饰，隐藏任务文字通过单个`role=status`、polite / atomic播报；目标WCAG 2.2 AA，自动化不构成达标声明，VoiceOver / 键盘和主题对比由用户手动验收。

**后续新增或替换插件Loading时，开发执行者须先询问用户是否采用Thinking Orbs / Beam这套方式，并说明用途及宿主主题处理。**不得擅自自绘动画或换用另一套动画。本轮已有明确授权，已有组件修复或用户明确要求沿用时不重复询问；新需求按当次用户决定执行。此约定适用于后续插件Loading选型，不意味着本轮扩展所有按钮和全局页面的既有Loading。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 保持小旋转图标 | 不满足整节点要求 |
| 仿照示例自行实现动画 | 用户明确禁止 |
| 仅Orb或仅Beam | 缺少用户指定的另一部分；采用整圈Beam和中央Orb |
| 依赖auto主题或默认彩虹色 | 不能可靠识别Harness主题；显式主题、mono与宿主墨色 |
| 所有跟踪状态持续动画 | 待确认 / 保存失败不等于正在执行；采用静态警告 |

## 后果

正面：各类节点状态一致，动画直接复用推荐依赖，宿主主题保持一致；隐藏和减少动态效果时节省动画开销，状态信息不只依赖视觉。

负面：增加两个MIT许可的客户端依赖和打包体积；Orb依赖Canvas2D，Beam依赖现代CSS属性 / 遮罩能力。密集节点时仍需实际浏览器性能和对比验收，不能依据HTTP加载或DOM测试承诺帧率。依赖升级需重新检查API、暂停及主题行为。

## 可逆性与重审条件

用户改变Loading选型、依赖维护 / 许可变化、宿主主题API变化、浏览器兼容性或动画开销不可接受时重审。版本回退按[ADR-0021](0021-local-update-and-package-retention.md)，仅回退插件与匹配配置，不删除画布 / 媒体或重复提交生成任务。

## 验证与证据

[节点与环境适配](../../src/client/NodeLoading.tsx)、[画布路由](../../src/client/Canvas.tsx)、[图片就绪](../../src/client/SignedMedia.tsx)、[视频首帧](../../src/client/VideoPlayer.tsx)、[音频就绪](../../src/client/AudioPlayer.tsx)、[样式](../../src/client/styles.css)、[锁定版本](../../package.json)。[专项回归](../../tests/nodeLoading.test.tsx)使用真实Beam / Orb，仅替换浏览器Canvas2D和布局环境：覆盖12种节点分支、不同执行 / 警告 / 文件加载状态、宿主优先于系统、墨色变化、隐藏 / 离屏 / 减少动态效果与pulse JS释放、成功到加载 / decode的连续过渡、视频首帧和音频波形失败边界、媒体DOM和原图保持。交付身份以0.2.40 manifest为准；用户人工视觉与VoiceOver / 键盘步骤见[清单](../manual-tests.md)175–178。
