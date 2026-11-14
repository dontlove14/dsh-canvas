---
name: canvas-fish-voice-discovery
description: Find Fish voice candidates using official public evidence. Use only when an ID is missing, not for user-supplied ID verification.
---
# Fish 官网候选

输入：主级音色方向、本批任务和搜索额度。只通过fish_voice_search/fish_voice_read读取Fish公开官网；不使用非官方ID、不猜ID。

用户已有ID不重新查找或要求核验。无ID时先按语言、性别感、年龄感、风格筛小量候选，逐条读取详情核对/m/后的真实ID、公开描述与适用理由。

候选依据网页描述，不能宣称已听过。官网样音不得下载、转发或作为合成试听；ModelLink兼容与质量必须由真实已授权TTS及用户试听确认。

交付audio-plan，content必须是JSON对象：{"candidates":[详情voice回执原字段及suitability],"limitation":"尚未试听/兼容性未核验或读取失败"}。不能交Markdown候选表；读取失败或无可用候选用candidates=[]，limitation写具体原因与主级用户指引。加载canvas-fish-voice-evidence核验。

官网不可访问或无可用ID时停止，不无限重试；交回主级，指引用户在可访问设备选音色，从/m/后复制ID发回。选择权归用户，不自动选一条来付费生成。

检查候选来自本批详情回执、无猜测ID、JSON字段完整、未把搜索列表当详情证据。
