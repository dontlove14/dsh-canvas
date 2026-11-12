# ADR-0088：已保存成果交接与独立身份

文档类型：架构决策记录；负责人：项目维护者 / 开发执行者；最近核对：2026-11-10。

状态：已采纳
记录日期：2026-11-05
实施版本：0.2.118；延续[ADR-0086](0086-creative-projects-and-scoped-canvas-executor.md)的创作分工和[ADR-0087](0087-visible-agent-collaboration-journal.md)中Agent 空间的事实来源；正式名称见[ADR-0093](0093-agent-space-name-and-integration-boundaries.md)。

## 背景与驱动因素

专业子级已保存检查点和最终成果后，宿主曾把 structured_output 全文再次保存，并使用批次 operationId 作为成果 ID。同批次先保存简报会产生 REQUEST_REUSED；重复保存同标题正文时，不同 Markdown 尾注会产生 FILE_COLLISION。子级实际已完成，宿主却无法交接。

成果文件名在第二次整体清洗时按140 UTF-8字节截断；长中文标题可能吞掉UUID和扩展名，使同标题的独立成果共享路径。需要保留存量身份、文件路径、认可和版本，而非改写历史数据。

1. 交接应依据实际保存回执，批次身份不占用成果身份，避免重复写入导致假失败。
2. 升级需兼容旧式完成和已有混用ID，同时保留原文件、来源、版本、认可及存量画布结构。

## 决策

批次 taskId / operationId 与成果 artifactId 分开。专业保存工具在写文件前拒绝新 artifactId 等于当前 taskId；已有混用ID记录仍可读取和幂等核验，不修改creative-projects v1、CanvasGraph或DDL。

| 生产者 → 消费者 | 契约 | 处理 |
| --- | --- | --- |
| 专业保存 → 宿主仓储 | 独立artifactId、draft、已读sources | 保存一次；相同ID与相同内容核验旧文件后复用，不重置认可 |
| 专业完成 → 宿主交接 | `{"result":{"artifactId":"保存回执中的UUID","summary":"可选简短说明"}}` | 必须为当前项目、当前批次artifactOutputIds中的实际产出；不能仅凭获授输入ID交接 |
| 尚未保存的专业完成 → 宿主交接 | `{"result":{kind,title,content,dependencies,assetIds}}` | 先与本批次产出的规范化draft精确比对；匹配复用，否则分配独立UUID保存新成果 |
| 旧式完成 → 宿主兼容 | 平铺完整draft | 同上；旧混用ID可被复用，不重新渲染文件或篡改旧成果 |
| 宿主交接 → 主级 | taskId、实际artifactId、draft、sources、version、status、needsReview、file、artifactOutputIds | 读取、依赖和认可使用artifactId；认可状态来自实际成果，不能以子级完成推定认可 |

原生 structured output 要求对象根、只支持有限JSON Schema子集；使用result内嵌oneOf，不用根oneOf或anyOf。UUID与2000字符summary等约束由宿主Zod再次检查。选择、核验、必要写入与完成状态走原串行队列；交接前后核验根身份、画布授权及同一实际工作区。

已保存成果以实际draft、sources、version、status、文件路径与哈希为准。交接先验证工作区中的普通文件及SHA-256；不存在、被修改、跨工作区、越批次均拒绝，不通过重新保存掩盖问题。保存新成果仍使用无覆盖发布。文件名预留`-UUID.md`字节，仅截短已清洗标题，整体不超过140字节，保留短标题原路径格式。

## 备选方案

| 方案 | 结论与原因 |
| --- | --- |
| 所有结果再次保存或仅更换Markdown尾注 | 不采用；重复写入且无法保留已有版本、来源和认可 |
| 只接收成果ID并立即废弃全文结果 | 不采用；升级中旧式输出和未保存结果需要兼容 |
| 成果ID优先、全文精确匹配后另存 | 采用；实际保存是事实，旧式结果可继续使用 |
| 将旧混用ID批量改写、恢复已删除文件或重跑失败批次 | 不采用；改变历史身份和用户文件，需要独立恢复任务 |

## 后果

正面：已保存成果只交接一次；批次与成果各自稳定，主级能读到实际最终版本；长标题不同UUID路径互不碰撞。
负面：旧全文匹配需遍历当前批次产出；新增一种完成消息形状和文件名长度预算。原有容量、资料上限与并发保持。

错误沿用CREATIVE_SCOPE、FILE_COLLISION、WORKSPACE_CHANGED、SPECIALIST_INCOMPLETE；新错误409 ARTIFACT_ID_IS_TASK要求在同一运行中换独立成果UUID。相同成功批次读取原回执且不spawn；失败批次保留成果和进度，以新批次续作。升级不修订历史失败状态、不恢复用户已删文件、不自动重提。

## 可逆性与重审条件

回退保留上一已核验0.2.117包与web profile冷备份；存量sidecar无需迁移。主级选择完成形状的规则、原生输出子集变化或未来跨宿主协作时重审此契约。

## 验证与证据

实现：[交接](../../src/host/agent/delegation.ts)、[专业保存](../../src/host/agent/creativeTools.ts)、[共享完成校验](../../src/shared/creative.ts)、[文件名](../../src/host/media/files.ts)。测试：[Agent专项](../../tests/agent.test.ts)覆盖原生输出Schema、保存一次、认可/来源/版本保留、旧式结果与混用ID、新全文另存、批次ID拒绝、长标题路径、越范围/缺文件/改文件/工作区切换及重复调用不spawn。

交付门槛为全量check、双构建一致、编译后离线交接、包与安装身份、HTTP加载及存量数据保留。真实模型协作质量由用户人工验收，不执行模型或付费调用作为自动验证。
