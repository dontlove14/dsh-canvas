# ADR-0061：媒体加载使用 ImageGeneration 像素效果

状态：已采纳

媒体阶段部分替代 ADR-0046 / ADR-0047。

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-29。
记录日期：2026-10-29。媒体动画依赖、主题、暂停或兼容策略变化时复核。

## 背景与驱动因素

1. 用户明确指定 [libraries.dev/image](https://libraries.dev/image) 替换图片、视频和音频文件加载时的三角形效果，要求适配 DeepSeek Harness 黑白主题。
2. 用户同时要求隐藏右下角 React Flow 字样，沿用原画布交互。
3. 该指定已构成选型授权，按 ADR-0046 不重复询问；媒体文件和生成任务应有独立阶段样式。

## 决策

锁定 `img-fx@0.5.1` 与其运行依赖 `three@0.186.1`，直接渲染真实 `ImageGeneration`，使用 `pixels-organic`。不传图片、不启用 autoReveal；实际文件链接、解码与首帧生命周期继续由原媒体组件掌握，不让动画重复获取媒体或模拟生成进度。

共用 NodeLoading 的 `media-loading` 分支覆盖图片 / 视频 / 音频资源、生成完成后文件等待、历史输出、引用图与独立预览。submitted / queued / generating / saving 保留 Beam / Orb，failed / unknown / save_failed 保留优先静态红色感叹号；文件准备完成或终态错误时停止效果。NodeLoadingBoundary 仍汇总就绪，只显示一个整节点动画，不重挂播放器、不改变节点尺寸或图数据。

显式传 Harness 的 light / dark 与计算后的 `--dc-surface`；对应预设使用黑白像素，背景跟宿主。共用现有单份主题订阅，主题变化原地更新。隐藏工作区 / 页面、离屏或减少动态效果传 paused；真实依赖共用一个 WebGLRenderer 和默认 10fps 调度，全部暂停 / 离屏后休眠，最后一个实例销毁时释放 GPU。应用不自绘动画、不逐帧更新 React、不修改上游引擎。

依赖按元素实际屏幕边界与其自身有限 DPR 分配画面；媒体像素效果采用该原生策略，不套用 ADR-0047 的 Orb 密度补丁。任务 Orb 继续使用原 1–8 倍整数密度与共享缩放订阅。仅媒体加载时不建立无用的 Orb 分辨率订阅。

WebGL2 或 ResizeObserver 不可用时采用静态单色方块提示；GPU 初始化失败由局部错误边界隔离。保留不拦截指针、无 Tab 入口、仅屏幕阅读器的单个 status，无可见状态文字。

React Flow 使用公开 `proOptions.hideAttribution=true` 隐藏署名，不修改依赖 CSS 或删除其他控件。未来新增 / 替换 Loading 仍按 ADR-0046 先询问选型；用户已经指定依赖时按当次决定执行。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 原文件阶段 Beam / Orb | 不符合本轮明确选择 |
| 自行仿制像素动画 | 不符合直接使用依赖要求 |
| 所有任务阶段同时替换 | 超出文件加载范围，保留原阶段区分 |
| 每节点独立 WebGL 引擎 | 增加上下文开销，使用依赖共享引擎 |

## 后果

正面：文件加载统一为用户指定的依赖效果，主题跟宿主、调度与GPU共享，原媒体就绪 / 任务生命周期保持。

负面：新增 MIT 许可客户端依赖与包体；WebGL2 兼容性与真实多节点性能需用户设备验收。自动测试替换 GPU 驱动，能检查真实组件 / shader 参数、共享调度、暂停 / 清理与错误隔离，不能代表实际 shader 编译、画质或帧率。初始化错误使用静态提示。

## 可逆性与重审条件

依赖版本、主题或目标设备兼容变化时重审。无 Host / API / 主库 / 预审库变更，无凭据或任务身份写入。回退按 ADR-0021 恢复匹配插件，保持业务数据，不重复提交任务。

## 验证与证据

[媒体效果](../../src/client/MediaLoadingEffect.tsx)、[状态入口](../../src/client/NodeLoading.tsx)、[画布](../../src/client/Canvas.tsx)、[真实依赖专项](../../tests/mediaLoadingEffect.test.tsx)、[媒体与任务回归](../../tests/nodeLoading.test.tsx)、[锁定依赖](../../package.json)。最终检查、双构建 / 编译 Host、同包安装 / 实际 preload 与两库身份以 `dsh-canvas-0.2.60.manifest.json` 为准，用户按[清单](../manual-tests.md)251–254验收。
