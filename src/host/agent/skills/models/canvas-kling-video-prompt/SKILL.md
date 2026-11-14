---
name: canvas-kling-video-prompt
description: Write Kling family director prompts anchored to composition, reference roles and concrete sound events. Use after video model confirmation, not external generation APIs.
---
# Kling 提示词

输入：宿主已确认kling型号、实时模式/参考角色与能力、获授构图/动作/对白、真实素材。本项目文本与Omni参考按当前能力选择；不借用其他站点的frames、elements、voice_ids或multi_prompt接口。

## 步骤

1. 先使构图可读：主体站位、景别、通路、关键道具与终态。需要准备关键画面时交assets按已选图片模型写规格，不在shots里自动生图或导入。
2. 正文写精简导演指令：谁在何处、一个核心动作如何发生、摄影跟谁/向哪/多快、动作完成后停在哪。静态外观沿真实参考保留，少堆重复质量词。
3. Omni每份参考按宿主referenceRoles区分普通参考、首/中/尾画面或视频用途；真实token明确角色及控制范围。首尾角色是Omni输入角色，不臆造另一个首尾帧模式。
4. 同一地点和连续动作先作为一次生成中的一个片段；明确需要内部切镜时写切点、切后景别与承接状态。需要拆段注明跳时、场景/参考冲突或预算原因，不机械按每个景别建节点。
5. 描述动作速度与摄影速度，慢动作只用于已授权重点，其他事件保持正常节奏。运镜要服务可见动作，不同时锁镜头又大幅绕拍。
6. 声音按声源和事件写，对白给说话者、原文与情绪。当前不支持音频参考就不连接音频，不将音频转视频当绕过手段；仍保留原生有声默认，缺音色不静音。

导演指令与Omni角色核对见[Kling工作表](references/prompt-workbook.md)。

交付：现有shot-plan中的中文prompt、片段/镜头关系、真实参考角色建议、时长/尺寸建议及声音验收点。具体数值与角色均取宿主实时目录。

检查：所选供应商与型号匹配；核心动作和终态清晰；参考角色实际受支持；参考并集数量/视频时长合法；没有外部音色字段或音频绕行。

阻塞：缺构图基准、角色或能力时报告缺口。不能自动生成、裁切、后期拼接或把未观看样例称为已验证效果。
