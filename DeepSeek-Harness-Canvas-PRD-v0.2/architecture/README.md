# Agent 与 DeepSeek Harness 架构规划图

文档类型：架构规划图说明；负责人：项目维护者 / 产品设计者；最近核对：2026-10-30。

依据 [PRD v0.2](../DeepSeek-Harness-Canvas-PRD-v0.2.md) 的第 3 章、FR-13 和 FR-14 制作。图中描述已选定的目标架构；Agent 专属接入、控制权交接和人工摘要同步尚未实施。插件具体创作功能、工具名称及参数仍待补充。

主交付为 `agent-harness-architecture.html`，可在浏览器中缩放、修改并自动保存到该文档的本机浏览器存储；维护源为 `agent-harness-architecture.excalidraw`。`agent-harness-overview.svg` 提供整体关系的静态预览。

图的阅读顺序：先看两种入口共用共享创作服务，再看原生提问与接管续作，最后看实施阶段。布局中的列表示职责，不是独立部署进程；页面、原生工具、共享服务与预设随同一个插件包交付，服务在宿主只加载一次。

Harness 使用已有主 Agent、模型路由与聊天界面。只有合格多模态模型可用于该助手；这不等于所有音视频输入形式已经得到支持。插件服务校验实际能力、目标、当前控制权与保存结果。媒体任务拥有独立生命周期。

配色证据于 2026-10-30 直接核对 Harness 官方文档站及其 CSS：

- [官方文档站](https://deepseek-harness.github.io/deepseek-harness/)：浅色中性色表面，以少量靛蓝强调主路径。
- [当前第一方样式](https://deepseek-harness.github.io/deepseek-harness/assets/style.CGm2E67g.css)：`--vp-c-brand-1` → `--vp-c-indigo-1` = `#3451B2`；背景 `#FFFFFF` / `#F6F6F7`；文字 `#3C3C43` / `#67676C`。

以上是第一方文档站视觉取样，不宣称是独立发布的品牌规范。节点轮廓及结构面继承 Whiteboard 的中性样式。浅色强调底色与主色上的文字对比色由主题生成器推导；本图未使用数据系列或语义状态颜色。`palette.json` 与 `theme/` 保存取样依据和可复现主题。

重新生成时，先通过 Whiteboard Design 的受控命令修订维护源，再使用相同文档 ID：

```bash
node "$WHITEBOARD_SKILL_ROOT/scripts/build-canvas-html.mjs" \
  --scene agent-harness-architecture.excalidraw \
  --out agent-harness-architecture.html \
  --title "Agent 与 DeepSeek Harness 架构规划" \
  --id dsh-agent-harness-architecture-v02 \
  --ui-theme warm-gray \
  --theme-manifest theme/manifest.json \
  --diagram-theme dsh-agent-architecture-v02 \
  --strict-colors \
  --strict-style
```

本图只记录规划，不改变本机 Harness 配置或已安装插件，不提交生成任务。
