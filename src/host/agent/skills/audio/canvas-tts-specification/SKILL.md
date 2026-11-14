---
name: canvas-tts-specification
description: Specify authorized FishTTS text and voice inputs. Use for separate speech or auditions, not native video sound policy.
---
# 独立TTS规格

## 输入与选择

输入：用户明确音色决定、授权范围/数量、新朗读文本，以及复刻时一份真实连接音频与其真实原文。用户已有ID直接使用，不再次查找/官网核验；无ID也无参考才交主级协调voice或用户，不猜ID。

## 工作步骤

1. 区分用途：固定音色试听、独立旁白/对白或单音频复刻；是否独立TTS由需求决定，不将所有视频声音改成后期配音。
2. 选一个音色来源：ID或一份已连接音频，二者互斥。复刻检查assetId/音频边、用途和真实reference_text；内容或授权缺失则标缺口。
3. 逐句核对新朗读文本与上游台词、说话者、语言、专名和数字读法。表演说明与实际文本分开，不改原文，不插媒体token。
4. 仅写本项目实际参数：type=tts、reference_id、reference_text（复刻时）、speed、volume；新文本在节点prompt。默认speed=1、volume=0，调整须有需求和现行契约依据。不新增emotion/temperature等字段或照搬其他模型标签。
5. 将音色来源、文本、数量、参数、精确引用建议和当前已获授权/待确认区分交主级。专业角色不自行调用生成、试听播放器、转写、混音或新外部服务。
6. 真实合成后由主级查询原taskId/assetId、展示只读播放器，用户试听决定；不能声称已听过、官网样音等于供应商效果，或以结构化文字冒充音频成果。

## 专业技巧

- 台词短句与停顿服务意图，但不能用超快speed修补镜头预算；长句需要story/shots协同。
- 复刻的reference_text是参考音频的原话，新prompt是要读的新话。无真实转写不能把新台词复制过去。
- 用户已经授权本轮具体音色与数量时复用，不重复询问；新增付费次数或改变范围交主级判断，不由专业角色自行扩量。
- 同内容试听、失败/未知任务先读原回执，不通过加空格、换ID或多次试音绕过稳定任务身份与授权。

参数字段、单参考复刻和试听交接示例按需读取[TTS规格核对表](references/tts-spec-checklist.md)。

## 交付与检查

保存audio-plan：用途、新prompt、实际ID或一份音频边、真实reference_text、type/speed/volume等现行字段、授权数量、说话者/预计窗口、依赖和待补项。输出是规格，不是已生成语音。

检查音色来源互斥、文本真值、参数/数量、参考原文、无媒体token、原任务身份和试听证据。视频原生声音仍默认开启；独立TTS不自动混入视频、替换音轨或完成嘴型同步，原成果/认可不改写。
