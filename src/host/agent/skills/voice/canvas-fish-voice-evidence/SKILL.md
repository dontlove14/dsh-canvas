---
name: canvas-fish-voice-evidence
description: Verify provenance of Fish candidate evidence. Use before candidate handoff, not audio playback or compatibility claims.
---
# 音色候选证据

输入：本批fish工具返回的官网记录、真实ID、详情URL与描述。候选必须对应本批实际读取证据；旧标题、外部文章或猜测ID不能升级为候选。

逐条检查官方主机与/m/路径、ID一致、页面实际可访问、描述支持方向。区分官方公开文字、自己的匹配判断和未试听事项；删除无证据断言。

例：“页面描述为普通话低沉男声，适合稳重方向；尚未合成试听”可交接。“我听过且肯定兼容ModelLink”无真实证据则不能写。

交付audio-plan，content是JSON：candidates数组每项含原详情voice回执的id/title/description/sourceUrl/sourceHash/retrievedAt，加suitability；limitation为非空未试听/未核验或失败说明。全部原字段逐项匹配本批回执，不添加字段。缺官网证据candidates=[]而非编造候选。候选不是用户已选音色；主级协调选择和真实TTS试听。

检查ID/URL/本批证据、无样音下载、无未经验证质量保证。用户给定ID走主级直接使用流程，不以本Skill再次查找。
