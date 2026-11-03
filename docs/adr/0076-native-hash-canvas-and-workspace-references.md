# ADR-0076：复用原生输入菜单的画布与工作区 # 引用

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-11-03。

状态：已采纳
记录日期：2026-11-02

实施版本：0.2.95。0.2.93候选的真实正向HTTP暴露未声明 workingDirectory 的Host依赖，94已补齐；用户实测另暴露客户端 remote.fileReferences 独立依赖遗漏，95按原生模块声明修复。Host / HTTP检查不能替代客户端作用域验证，新增实际客户端入口与真实 Cordis 权限回归，最终以95manifest为准。

0.2.105修复预设范围：标准模式输入 `#` 曾触发画布候选HTTP并得到403。客户端现在只在公开 `agentPreset` 投影确认主预设 `canvas-creator` 时启用；本轮证据以105manifest为准。

0.2.106修复紧接文字的触发：`反馈#`、英文及emoji后的 `#` 均可打开菜单，无需先输入空格。引用替换仍只覆盖从 `#` 到光标的原始范围。

## 背景与驱动因素

1. 用户反馈某个生成结果时需要手输节点名，重名、历史结果与名称变更容易指错素材；希望在 Agent 输入框输入 `#` 选择准确内容。
2. Harness 原生 `@` / `/` 已有输入框上方菜单、分组、键盘操作与引用标签，但发布 SDK 的触发字符仅支持这两种；应复用原生行为而不修改宿主依赖。
3. 当前画布必须按根 Agent 会话关联确定，工作区按真实 workingDirectory 确定；读取不得变成生成、图连线或任意文件访问。

## 决策

Client 用公开 `InputTriggerController` 构造当前会话的独立引用控制器，通过可卸载的 `sessionOf` 适配器接入原生输入和原生 MenuView。在检测投影把光标前合法 `#` 替换成等长 `@`，并将其前一个非空白Unicode字符替换为同UTF16长度的空格，以满足原生 `@` 语法的边界条件；不要求真实草稿有空格。编辑器原文、UTF16范围与 draftRev 保持，选取素材及目录展开只替换原始 `#` token；emoji不拆断、光标后的文字保留。Native 菜单提供上下键、Enter、Tab、Esc、IME与输入框上方定位；原 `@` / `/` 控制器保持独立。SDK 公共类在构建时映射原生 ModuleLoader 的包根 ID，精确固定开发依赖，不把第二份 SDK 打进插件。

启用条件来自当前 retained binding 的公开 `session.projections.faceOf('agentPreset')`，值必须严格等于 `canvas-creator`。标准、专业子预设、null或尚未加载的undefined均将 `#` 当普通文字，不查询候选或文件。订阅预设变化：确认无限画布后重新检测当前草稿；切走立即关闭菜单、取消请求并恢复原生控制器。请求返回后和选取时再次核对可用性，取消后晚到的结果不能继续查询文件、打开菜单或插入引用。已有引用在其他预设发送时由本地明确提示阻断、保留草稿，不发解析HTTP；历史及剪贴板仍保留原身份。投影订阅随binding或插件卸载清理。Host的主Agent鉴权继续保持。

候选优先为根会话最近关联画布的实际媒体，列出图片 / 视频 / 音频、当前 / 历史及原文件名；随后使用原生 `fileReferences.list` 查询当前工作区文件和目录。目录通过原生输入事件继续 `#目录/`，有空格时保留引用路径语法；不把目录当作可读文件。菜单请求跟随原生 AbortSignal，会话控制器随 retained binding 释放，卸载恢复原 resolver 并通知已挂载订阅者。

插入标签显示 `#名称`。版本1共享引用分别携带 session/canvas/node/asset 身份，或 session/cwd/path 身份。发送时通过 owner HTTP 重新核验归属、节点素材关系、locator、真实工作区与普通文件；文件钉住 bytes/mtime/inode。序列化和剪贴板保留转义 JSON 标记 `<canvas-reference>`，历史用原生 UserTextRegistry 展示简短标签；无 URL / 凭据 / 图字段变更。失败由原生发送流程阻断，保留草稿。

Host 仅解析根会话 `user/message` 且 source=user 的引用，动态上下文与 `canvas_inspect.userReferences` 给出 referenceId；专业子 Agent 不获得此列表或读取工具。`canvas_read_reference` 只接收已提交 referenceId，媒体再次核验原 assetId，图片沿既有原生附件通道提供真实字节；视频 / 音频只返回元数据并明确未理解。文件拒绝越界、符号链接、非普通文件、变化的工作区或 pinned 文件；读取最多 min(2MiB,maxReferenceBytes)，受支持图片实际进入模型上下文、有效 UTF8文本返回正文，其他文件仅元数据。人工接管仍撤销工具画布权限，选择和发送本身是只读操作。

| 责任边界 | 输入 → 输出 | 验证 / 故障 |
| --- | --- | --- |
| Client 输入适配 / 执行者 | retained session → 原生菜单与引用事件 | UTF16 / 键盘 / 取消 / 卸载专项；不修改宿主文件 |
| HTTP / Coordinator | 当前根 Agent 身份 → readonly候选 / submit核验 | owner认证；跨会话403，删除 / 切换409，发送失败保留草稿 |
| 受控读取 / 执行者 | 根用户 durable refs → metadata / 真实附件 / bounded文本 | 不推测视频听审；文件身份与接管再次核验 |
| 用户验收 | 原生界面和真实反馈效果 | 手动356–361；自动化不能替代视觉和创作判断 |

## 备选方案

| 方案 | 取舍 |
| --- | --- |
| 修改原生SDK的触发字符或复制完整输入组件 | 侵入宿主升级，易破坏原有编辑 / 键盘 / 草稿；不采用 |
| 插入节点名称或文件路径纯文本 | 无法钉住历史素材，重名 / 切工作区后会指错；不采用 |
| 插件适配公开控制器和原生引用标签 | 可卸载、原生CAS及菜单行为保持；采用，兼容性用未改发布SDK专项约束 |

## 后果

正面：用户可选择准确素材并直接描述问题；原生菜单、分组与历史标签保持一致。读取没有生成或导出副作用，存量数据格式保持。

负面：适配器仍依赖 SDK 的公开会话 resolver 和控制器契约，升级必须验证；大文件和未支持的二进制格式仅返回元数据，视频 / 音频没有自动观看或聆听能力。剪贴板文本含身份标记，跨会话粘贴不会获得其他会话权限。

## 可逆性与重审条件

卸载恢复 resolver与UserText注册；已提交原文保留但不授予读取权限，不删除历史。SDK提供原生 `#` 扩展、增加受控文档 / 视频理解、引用预览或需要跨会话引用时重审；不得借此扩展图Schema或通用文件工具。

## 验证与证据

[共享引用](../../src/shared/chatReferences.ts)、[输入适配](../../src/client/chatReferenceTrigger.ts)、[原生消息标签](../../src/client/chatReferenceText.tsx)、[Host](../../src/host/agent/chatReferences.ts)、[工具](../../src/host/agent/preset.ts)、[原生菜单专项](../../tests/chatReferenceTrigger.test.tsx)、[真实客户端作用域](../../tests/sidebarCanvas.test.tsx)、[真实工具与存储专项](../../tests/agent.test.ts)。全量、双构建、SDK、包 / 实际安装 / 正向HTTP与数据保留以95manifest为最终证据；93的Host和94的客户端依赖遗漏均已记录，不能将HTTP通过等同于完整浏览器验收。浏览器与真实模型反馈待用户手动356–361。
