---
name: agent-capability-governance
description: Maintain the canvas Agent, Skill and host permission design. Use when adding agents or capabilities, not for unrelated UI changes.
---
# Agent 能力变更治理

任何新增子Agent、给既有Agent增加能力、接入新Skill或工具，都遵循[ADR-0104](../../../docs/adr/0104-agent-skills-and-host-authority.md)，不能只扩大提示词或开放通用终端/文件工具。

输入：用户已授权范围、现有角色与真实工具、资料/画布授权和预期成果。先确定是现有角色追加方法、工具扩展，还是确需新角色。

步骤：
1. 第一层声明角色身份、职责、协作方式和硬边界；新角色同步预设、共享角色契约、真实子身份与Agent空间只读映射。
2. 第二层提供按任务触发的Skill，包含输入、专业步骤、具体例子、交付、检查与阻塞；稳定名称匹配目录。随包清单、版本、正文/资源哈希和最小默认加载同步维护。
3. 第三层在AGENT_CAPABILITIES登记精确工具白名单，同时由restrict、guard及宿主身份/批次/资源授权校验。读取Skill不增加权限，方法不能绕过用户决定。
4. 验证跨角色加载、同名覆盖、资源路径、必备缺失、取消迟到、真实成果回执和并行隔离；有写操作核对精确commands、CAS/epoch/幂等。
5. 公共行为/接口变化写ADR与操作说明，执行现有check、双构建、包/安装身份和web3080重启核验。

交付：实现、方法、权限、检查和文档一起可审阅。没有实际观看/试听/剪辑工具不得以Skill声称新增该能力。图片/视频仍用户点击生成，TTS需精确授权；支持视频声音默认开启，静音要真实用户依据。

检查历史图/DDL/任务/成果ID与认可不迁移、不重提生成。若方法缺失或权限无法成立，阻塞该能力，不影响独立成功项。用户已授权实施和本地发布时直接完成，不重复请求批准。
