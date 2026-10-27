# ADR-0009：共享 React 与 Harness lazy 浏览器构建

状态：已采纳（补录）

文档类型：解释；负责人：项目维护者；最近核对：2026-10-26。
补录日期：2026-10-26；原决策日期未单独留档。复核规则见[ADR 索引](index.md)。

## 背景与驱动因素

1. Harness 浏览器模块由特定 loader 加载，普通独立网页产物无法直接代替插件入口。
2. React hooks 要使用宿主共享实例，重复打包 React 易造成运行时问题。
3. React Flow 和样式是插件私有能力；开发页与正式构建需要一致 JSX 语义，已有 React 未定义故障说明配置边界必须明确。

## 决策

浏览器代码由 esbuild 生成 CommonJS 工厂，注册到 Harness lazy ModuleLoader。React / React DOM / JSX runtime / Cordis / Zod external，React Flow 私有打包；插件和 Flow CSS 以文本注入并随插件释放。

宿主构建 Node 22 ESM，双方各自类型检查并生成声明；开发 Vite 页面使用项目自动 JSX runtime 配置。兼容基准为实际核对过的 Harness 版本，不把 package engines 范围等同全部已验证版本。

## 备选方案

| 方案 | 未选择的原因 |
| --- | --- |
| 给 Harness 加载普通 Vite 独立应用 | 不符合当前插件 loader / 共享依赖契约 |
| 将 React 与 React Flow 一起私有打包 | React 实例和宿主渲染器可能不一致 |
| 强制宿主提供 React Flow / 插件 CSS | 增加宿主版本耦合，插件不自包含 |

## 后果

正面：匹配宿主加载契约；共享 React 避免实例冲突；Flow 与样式随插件交付；开发复用 UI。

负面：依赖 Harness loader API 和共享包解析；双入口与声明生成增加构建步骤；私有 Flow 增大浏览器包；需要独立验证版本升级。

## 可逆性与重审条件

宿主 loader 改用标准 ESM 或共享依赖策略变化时可替换构建封装，保持业务 / 持久层不变。Harness / React 主版本或 Flow 升级时重新做类型、构建和宿主加载验证，再扩兼容承诺。

## 验证与证据

[build.mjs](../../scripts/build.mjs)、[package.json](../../package.json)、[客户端入口](../../src/client/index.tsx)、[根 tsconfig](../../tsconfig.json)、[开发入口](../../src/dev/main.tsx)。既有类型 / 构建 / 模块注册已核对，完整 UI 仍见[验证记录](../verification.md)。
