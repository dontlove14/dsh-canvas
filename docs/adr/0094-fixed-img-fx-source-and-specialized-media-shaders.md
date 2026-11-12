# ADR-0094：固定 img-fx v0.6.0 源码与媒体着色器修复

状态：已采纳

部分替代 [ADR-0061](0061-dependency-backed-media-pixel-loading.md) 的依赖版本和分发方式，其媒体阶段、主题和生命周期决策继续有效。

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-11-11。
记录日期：2026-11-11。上游版本、源码身份、编译策略或设备验收变化时复核。

## 背景与驱动因素

1. 用户报告 Windows 桌面与 Web 在上传图片、重开画布时卡住后恢复，并明确授权“按方案引入 v0.6.0 修复源码，保留动画并测试”。
2. [img-fx issue 3](https://github.com/Jakubantalik/img-fx/issues/3) 与 [Libraries.dev PR 26](https://github.com/Jakubantalik/Libraries.dev/pull/26) 将 Windows ANGLE / D3D 首次渲染阻塞关联到包含全部效果的着色器编译。上游改为按效果生成程序及按像素格计算后合成；上游只报告 M1 Max Chrome 验证，未验证 Windows。
3. npm 仍提供 0.5.1，[issue 4](https://github.com/Jakubantalik/img-fx/issues/4) 记录 0.6 发布失败；必须固定可追溯的源码并随包编译，避免依赖临时下载目录。

## 决策

使用 [img-fx v0.6.0](https://github.com/Jakubantalik/img-fx/tree/2098279964046e23bad86d9f42f41a3b06dca735)，提交 `2098279964046e23bad86d9f42f41a3b06dca735`。完整上游 `src` 原样保存于 `src/client/vendor/img-fx/upstream`，保留 MIT LICENSE、上游 package.json 与逐文件 SHA-256 清单；不修改上游代码。移除 npm `img-fx@0.5.1`，保留 `three@0.186.1`，新增匹配的开发类型声明。客户端直接导入固定源码中的真实 ImageGeneration。

构建前核对完整文件集合与哈希，失败停止构建；源码编入客户端，同时将原源码、许可与身份清单保留于 `lib/vendor/img-fx`，随既有 tgz 分发。安装不需要 GitHub、源码暂存目录或独立 img-fx 包。产物核验检查固定源码及编译客户端包含按效果 / 两步渲染修复。

保留 `pixels-organic`、Harness light / dark 和表面色、无媒体输入与 `autoReveal=false`，沿原 NodeLoading 入口覆盖全部画布中的图片 / 视频 / 音频文件加载。Chromium Flow 只生成效果 22 的程序；按上游实现先计算格点颜色，再合成完整画面，共用材质、纹理目标和 GPU。浮点附件不可用时依次尝试半浮点和 8-bit；均不可用时使用仍按效果裁剪的单步动画。任务 Orb / Beam、实际媒体就绪、暂停 / 离屏 / 最后实例释放和既有无 WebGL2 静态兼容策略继续沿用。

此实现不引入 `compileAsync`，自动测试不能证明 Windows 驱动编译不再阻塞。客户端卡顿改善和原故障因果均以客户实机证据为准；本轮不处理上传 503 或启动写锁。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 关闭全部 WebGL Loading | 不符合保留指定动画的授权 |
| 普通 npm 升级到 0.6.0 | 注册表尚无该发布，无法保证安装 |
| 修改 0.5.1 自行裁剪或仿制动画 | 难以核对上游修复与视觉一致性 |
| 固定上游源并随客户端编译 | 已选择；来源、许可与文件身份可复核，安装不依赖源码下载 |

## 后果

正面：保留指定动画与既有媒体生命周期，实际执行上游按效果和按格点渲染修复；包可独立分发且源码身份可追溯。

负面：维护固定源与额外源码产物；真实 GPU 编译、Windows ANGLE、画质和多节点性能仍需实机验收。上游单步兼容仍有同步编译，不能把专项自动测试描述为 Windows 卡顿已解决。

## 可逆性与重审条件

无 Host / API / CanvasGraph / DDL / 存量任务协议变更。按 ADR-0021 在原 web / 3080 安装与正常重启，保留前包至新包加载和数据核验成功；回退只恢复匹配插件，不清空数据或重提任务。npm 正式发布、后续兼容修复或 Windows 仍阻塞时重审固定版本。

## 验证与证据

[媒体入口](../../src/client/MediaLoadingEffect.tsx)、[来源清单](../../src/client/vendor/img-fx/source.json)、[构建身份检查](../../scripts/img-fx-source.mjs)、[客户端构建](../../scripts/build.mjs)、[产物核验](../../scripts/verify-artifact.mjs)、[真实依赖专项](../../tests/mediaLoadingEffect.test.tsx)、[媒体生命周期回归](../../tests/nodeLoading.test.tsx)。

专项 34 项通过，其中 9 项直接运行上游组件 / 调度 / 着色器源码，仅替换 jsdom 无法提供的 GPU 驱动；覆盖效果 22 裁剪、两步渲染 / 材质与目标共享、附件降级、上下文丢失恢复、主题、暂停 / 离屏 / 清理及错误隔离。全量检查、双构建、同包安装与实际 preload 以 `dsh-canvas-0.2.131.manifest.json` 为准。Windows Chrome / 桌面验收按[手动清单](../manual-tests.md)411–413执行，当前未验收。
