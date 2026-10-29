# ADR-0047：随画布缩放提高依赖动画的绘图分辨率

状态：已采纳
0.2.60起本策略仅适用任务 Orb；文件加载采用 [ADR-0061](0061-dependency-backed-media-pixel-loading.md) 的依赖原生像素密度，不再渲染媒体 Orb。

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-28。
记录日期：2026-10-28。动画依赖、像素密度上限或缩放订阅变化时复核。

## 背景与驱动因素

1. 用户反馈放大画布后中央Loading发糊，截图中ThinkingOrb的栅格较软，而名称与端点相对清楚。
2. `thinking-orbs@0.3.2`内部仅采用最多2倍屏幕DPR，Canvas2D像素数不随React Flow缩放增加；放大时浏览器只能插值已有像素。64 / 32 / 20是动画设计档位，不能用任意size替代像素密度。
3. 用户要求动画直接使用依赖，保留Beam / Orb、宿主主题、不同阶段和隐藏暂停；不能通过自绘动画、修改全局DPR或强制每个节点3D合成解决。

## 决策

沿用[ADR-0046](0046-dependency-backed-whole-node-loading.md)的真实组件和所有动画预设、墨色、暂停及无可见状态文字约定。通过一个可重复执行的[依赖补丁](../../scripts/patch-thinking-orbs.mjs)，为锁定的0.3.2组件增加可选`pixelRatio`，仅改变Canvas2D backing尺寸及绘图effect依赖；未传值时保持上游行为。不改引擎、frame函数、粒子数、速度、主题或CSS尺寸，Beam仍用其原生CSS几何。

补丁同时覆盖ESM、CJS和类型声明，执行前核对精确版本及三个上游文件SHA-256，已完整应用则只校验，未知内容和不完整单文件补丁失败停止。所有文件验证后才写入；替换inode避免污染pnpm共享硬链接。发布包包含同一个补丁脚本，postinstall / pretypecheck / pretest和build入口验证，防止重装依赖后丢失；浏览器实际使用构建内已打包的依赖，无运行时下载或篡改。

加载组件的像素密度为`ceil(屏幕DPR × 画布zoom)`，限制1–8，64px主Orb最高512×512；向上取整不低于目标屏幕密度，当前最大画布倍率2.5与常用Retina DPR2对应5倍，DPR3对应8倍。非法输入按1倍回退。提高像素数不提高粒子数。小型引用图仍保持20px设计，只增加真实像素。节点外预览没有画布缩放，只计算屏幕DPR；因此不会随着后方画布放大无效分配。

工作区通过[分辨率Store](../../src/client/loadingResolution.ts)直接读取React Flow实际transform，覆盖滚轮、控件、小地图与fitView；首个Loading订阅时才建立一个视口 / resize / resolution媒体查询监听，最后一个结束时释放。平移和同一整数像素档位不通知React；仅Loading通过useSyncExternalStore更新，不把zoom写入节点数据或逐帧重建工作区、图片、音频。屏幕DPR变化时重新监听新resolution查询。暂停状态可以更新静态画面的分辨率，但不能因此重启动画循环。

继续保留[ADR-0032](0032-scale-aware-viewport-compositing.md)缩放 / 静止释放全视口合成缓存的策略。图片使用原图，视频与原媒体分辨率不变；本轮只消除动画像素不足的确定原因，不对超过原图分辨率的内容承诺无损放大。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 任意增加Orb size再反向CSS缩小 | size是调校设计档位，不是分辨率，改变动画外观且超出依赖类型 |
| 自绘、替换frame或修改全局devicePixelRatio | 违背用户依赖要求或影响其他组件 |
| 固定每个Orb使用8倍像素 | 简单但普通倍率持续浪费栅格内存和填充工作 |
| 受校验的依赖pixelRatio扩展与按档位更新 | 保留真实动画和设计尺寸，随实际缩放增加像素，采用 |

## 后果

正面：放大时依赖重新绘制更细的栅格，保持原动画、主题、节点和媒体生命周期；平移不增加React更新，像素分配有上限。

负面：放大时像素填充量和backing内存增加，8倍64px RGBA约1MiB / Orb；多任务仍需目标设备验收。维护一个小型依赖补丁，上游版本或内容变化必须重新核对，不静默继续。

## 可逆性与重审条件

这是纯客户端渲染与构建适配，不更改图、数据库、任务、OSS或凭据。上游提供原生密度API时移除补丁并迁移；提高最大zoom、DPR超过2或目标设备出现开销 / 清晰度问题时重审上限。回退遵循[ADR-0021](0021-local-update-and-package-retention.md)，不删除业务或重提任务。

## 验证与证据

[真实依赖与工作区回归](../../tests/nodeLoading.test.tsx)检查Retina与2.5倍实际XYFlow缩放下64px Orb拥有320×320 backing、绘图变换为5、DOM / CSS尺寸与媒体读取保持；覆盖小数档位、平移不重绘、缩小、compact引用 / 独立预览、屏幕DPR变化、暂停不启动帧及订阅释放。[补丁回归](../../tests/patchThinkingOrbs.test.ts)检查干净安装应用、重复应用、未知版本 / 内容拒绝与引擎保持。[接入](../../src/client/Canvas.tsx)、[组件](../../src/client/NodeLoading.tsx)、[构建](../../scripts/build.mjs)、[生命周期与包文件](../../package.json)。版本0.2.41按现有管线交付；实际清晰度与连续缩放由用户按[手动清单](../manual-tests.md)179–180验收。
