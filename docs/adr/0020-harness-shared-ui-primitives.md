# ADR-0020：优先复用 Harness 通用组件与缺失控件的样式规则

状态：已采纳

文档类型：解释；负责人：项目维护者；最近核对：2026-10-29。
记录日期：2026-10-26

## 背景与驱动因素

1. 用户要求插件的单选、输入等组件优先使用 Harness 通用组件库；没有对应组件时，保持与宿主控件一致的 UI。
2. 仅继承颜色不足以统一组件：旧 select、输入框、按钮在字号、尺寸、边框、交互和焦点上仍与宿主不同。
3. Harness 浏览器平台公开提供通用 UI 模块。复用宿主实现可同时继承主题、菜单定位、键盘导航和弹窗焦点管理，避免复制内部 CSS 类。
4. 独立开发入口不具备 Harness 平台模块加载器，必须保留能够运行的开发控件；不能因此把宿主整套组件及其 Markdown / 高亮依赖重复打入插件。

## 决策

- 使用公开包 `@deepseek-ai/dsh-client-ui-primitives`。已核对目标版本 `0.2.1-rc.2` 的公开导出、类型和平台模块注册，包含 `Button`、`Input`、`Checkbox`、`SegmentedControl`、`Menu`、`Modal` 等。
- 由 Harness 入口导入运行时，向画布和原生设置入口提供稳定的组件上下文；构建将该包 external，交由 Harness 平台模块加载器共享。开发依赖固定到已核对版本，不增加服务端依赖或 Cordis 服务注入项。
- 设置、画布编辑器、任务 / 存储和列表操作使用统一的轻量封装。按钮、单行输入、复选框、模型类型分段、操作菜单和弹窗优先调用官方组件。
- **没有公开的 Select 或 Textarea 组件。** 单选下拉使用官方 `Button` + `Menu`：受控值、当前选择标记、禁用状态、可访问名称和菜单语义；定位、滚动、方向键、Escape及焦点回归由官方菜单负责。不伪称原生 listbox。
- 下拉菜单使用官方 body portal，避免浮动编辑器 / 设置区域的 overflow 裁切。Harness 内弹窗同步使用官方 `Modal`，避免 body 菜单被 HTML dialog 的顶层遮住。菜单打开时 Escape 先交菜单处理。
- 2026-10-27补充菜单间距：UiActionMenu默认4px，“添加节点”设14px，避开工具栏6px内边距。通过公开 `Menu.getAnchorRect` 对按钮定位矩形施加间距差，继续由宿主跟随位置 / 尺寸变化并限制视口边界；独立开发菜单用同一gap变量。不覆写宿主私有样式或改变其他菜单默认定位。
- 多行提示词保留 HTML textarea，使用官方 Input 的主题 token、字号 / 行高、边框和圆角，保留换行、字符限制与尺寸调整。隐藏文件 input 和媒体 / 项目等业务点击区域保留各自语义。
- 插件 CSS 对官方控件排除旧的通用 button / input 覆盖；官方控件仅接受布局和尺寸定位钩子，业务危险操作可使用宿主错误语义色。禁止引用组件内部哈希类名或复制官方实现。
- 0.2.26核对公开Input渲染为带padding的span内层。UiInput的原生外层和直接内层均按border-box计宽，内层100%包含padding / border，防止任务筛选和分页固定宽度溢出；仅修正布局钩子，不改官方颜色、焦点或交互。
- 0.2.74设置弹窗仅保留Modal标题，CanvasSettings在弹窗内关闭重复标题，宿主独立设置入口继续保留自身标题。公开contentClassName覆盖的区域包含标题和body：用设置专用作用域及子元素关系限制伸缩，只有标签页内容滚动，标题 / 标签栏固定；不引用私有CSS类。切换标签重建内容容器，从顶部显示。独立dialog沿用同一内容滚动边界并显示唯一标题。
- 独立开发页用 HTML 控件兜底，遵循同一语义 token 和标准控件尺寸；HTML select 保留本机系统交互。此兜底不表示 Harness 缺少组件，也不在 Harness 中静默替换失效的模块。
- 新增 / 修改控件先检查目标 SDK 的公开导出，存在即复用；缺失则优先组合官方原语，再按宿主 token 实现。保留 [ADR-0019](0019-harness-settings-and-theme-inheritance.md) 的宿主主题权威和即时继承。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 继续全部手写，只对齐颜色 | 字体、尺寸与键盘行为仍会漂移，不采用 |
| 全量打包官方组件库 | 重复宿主运行时，带入不必要的 Markdown / 高亮等依赖，不采用 |
| 引用宿主内部组件路径或哈希 CSS 类 | 不属于公开契约，升级容易失效，不采用 |
| 平台共享官方原语，缺失控件组合 / 按 token 实现 | 遵守公开边界、复用主题和交互，同时保持独立开发可用，采用 |

## 后果

正面：两处设置与画布 / 列表使用同一宿主组件，主题和键盘行为一致；菜单避免容器裁切；不重复打包通用组件库，也不新增持久数据。

负面：插件依赖目标 Harness 的公开平台模块和组件 API。官方 Menu 是菜单语义而非完整 HTML select API；若以后需要表单原生提交、搜索、多选等能力，须重新评估。独立开发页的系统 select 不能代表 Harness 下拉视觉验收。

## 可逆性与重审条件

本次只改变客户端呈现与构建共享声明，不改变数据库、任务身份、模型协议、API Key或存量数据。拥有可用的0.2.2包时可回退恢复旧控件；压缩包保留遵循 [ADR-0021](0021-local-update-and-package-retention.md)，不承诺已清理旧包仍可取得。

Harness 升级时复核平台模块和公开参数。若官方新增 Select / Textarea，优先改用对应组件；若移除或更改原语、修改主题 token、出现弹窗 / 键盘不兼容，则重审封装和兼容范围。

## 验证与证据

- [官方插件参考](https://deepseek-harness.github.io/deepseek-harness/reference/)、[开发文档](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)、[指南](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)；插件接入约束见 [ADR-0017](0017-harness-official-cases-and-badcases.md)。
- [官方固定版本源码](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.2)：本次核对 tag 对应提交 `687f282e8625c6b8d11ff58211a90524be2e4317`，平台 `PLATFORM_MODULES` 提供该包。已安装宿主的浏览器 bundle 也包含同名模块。
- [npm 公开包](https://www.npmjs.com/package/@deepseek-ai/dsh-client-ui-primitives/v/0.2.1-rc.2) 的 `lib/types/index.d.ts` 与 Button / Input / Checkbox / SegmentedControl / Menu / Modal 声明为调用依据；不通过私有文件路径导入。
- 实现：[组件封装](../../src/client/ui.tsx)、[Harness 入口](../../src/client/index.tsx)、[构建共享](../../scripts/build.mjs)、[样式](../../src/client/styles.css)、[设置](../../src/client/Settings.tsx)、[画布](../../src/client/Canvas.tsx)、[列表](../../src/client/ProjectList.tsx)。
- 自动化与产物证据记于[验证记录](../verification.md)；实际键盘、菜单与主题视觉由用户按[手动清单](../manual-tests.md)验收。
