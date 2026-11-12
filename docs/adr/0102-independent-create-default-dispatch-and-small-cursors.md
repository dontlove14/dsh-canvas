# ADR-0102：独立新建清单默认并行与小尺寸光标

文档类型：架构决策记录；负责人：项目维护者 / 开发执行者；最近核对：2026-11-12。

状态：已采纳
记录日期：2026-11-12。
部分替代：[ADR-0101](0101-parallel-canvas-executors-and-observed-cursors.md)中 canvas_execute 总是启动单实例及原光标形状。资源调度、精确授权、短事务、只读事件与人工生成边界保持。

## 背景与驱动因素

1. 用户在 session-7a4b0ea1-e1f9-4df2-a883-3f9f0ea9c7b4 中观察到新建十个节点仍逐个执行。只读核对公开工具事件：主级用 canvas_execute 提交十项创建命令，实际只派出一个 executor，未使用并行入口。已有并行能力依赖主级主动选择工具，因此未满足独立批量创建的预期。

2. 用户另指定 arrow-cursor-2--mouse-select-cursor.svg 的箭头外形，并要求大小为原来的一半。

## 决策

canvas_execute 增加可选 executionMode=auto/serial，省略等同 auto，但不向旧输入填充默认字段，保持旧 ledger 参数哈希。宿主仅对两个及以上、全部为 canvas_create_node 的新鲜清单自动拆分：操作 ID 唯一、对应节点未存在、修订一致，references.source 和 placement.anchorNodeId 均不指向本批新节点。共用已有只读参考允许并行。

按原清单轮转分成 min(maxConcurrentAgents, 命令数) 份，配置默认四、范围一至四。每份是实际子会话，批次 ID 由原批次 ID 和分组序号稳定派生；原命令 ID、参数、模型、引用、成果依赖保持。各实例内部顺序执行，最终短事务串行提交，自动布局在提交时读取最新图。

单命令、混合编辑 / 导入 / 生成、本批新节点引用或布局依赖保持单实例。用户要求逐个执行或存在宿主无法判断的语义先后要求时，主级明确设置 serial。其他独立编辑仍由主级用 canvas_execute_parallel 组织；该入口按 supplied tasks 派发，不再次自动拆分。

原 canvas_execute 批次 key 与完整输入先经过原 started / completed 幂等门，再派子任务；完成、失败、升级前和中断批次均不自动重新 spawn。组本身不占模型名额、不创建虚假 child 或光标。原批次在 creative 记录汇总，实际子任务沿原协作日志保存。返回原 completed/receipts/revision/taskId/stopReason/summary，receipts 保持原清单顺序；自动并行时额外返回 dispatch={mode:"parallel",tasks:[{taskId,status,value?,reason?}]}。完成要求所有分支完成且命令实际回执齐全，失败保留独立成功，不重提未知任务。

光标内联用户 SVG 的唯一 path 与 1024×1024 viewBox，不加载上传文件的 DTD / 脚本 / 外链。屏幕盒从 26×30 缩为 13×15，保持原图比例，文本操作也使用指定箭头。四实例使用四种主题协调颜色，标签仍可读；缩放、只读投影、逐实例清理、后台 / 重连不补播保持。

## 备选方案

| 方案 | 判断 |
| --- | --- |
| 仅加强主级提示 | 无法保证选中并行入口，宿主为独立新建提供默认派发 |
| 自动拆分所有命令 | 会破坏引用、布局与付费顺序，仅自动拆分可静态证明独立的新建 |
| 不提供顺序选项 | 宿主无法判断全部语义先后要求，serial保留主级明确控制 |

## 后果

正面：独立新建默认使用多个真实实例，保持原清单授权、回执顺序和历史幂等性，光标尺寸符合用户要求。

负面：增加模型并发可能增加上下文及限流压力，不承诺固定速度或费用；容量一恢复单实例。

## 可逆性与重审条件

无新依赖、HTTP 路由、图 / DDL 或专用持久队列，不重放用户历史十节点操作。沿已授权 web / 3080 安装重启，核验成功前保留 0.2.141 回退。
若要自动拆混合编辑、推断语义依赖或增加长期任务队列，另行决策；回退不恢复旧数据或重提生成。

## 验证与证据

[真实 ToolRuntime 回归](../../tests/agent.test.ts)以模型 activation 替身验证一次十创建启动四个真实子作用域、精确授权隔离、十个不同落点、原序回执、逐实例光标清理、serial、旧回执 / started 不重派及失败成功分支保留。[规划反例](../../tests/executionScheduler.test.ts)覆盖共享已有参考、本批引用 / 锚点、混合操作、旧节点、不同修订和容量一；[UI](../../tests/executorCursors.test.tsx)核对指定箭头 viewBox 与半尺寸，原角色 / epoch / 后台反例继续通过。

全量 check、双构建、编译 smoke、同包实际安装、HTTP preload 与数据身份以 0.2.142 manifest 为准。没有真实模型或浏览器自动化；用户手验 [439–442](../manual-tests.md)。
