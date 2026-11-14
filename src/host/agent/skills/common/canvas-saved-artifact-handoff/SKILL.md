---
name: canvas-saved-artifact-handoff
description: Reuse saved artifact identities and hand off actual receipts. Use when saving or returning results, not granting approval.
---
# 已保存成果交接

输入：本批projectId/taskId、角色与获授依赖/素材/来源、本批实际保存或执行回执、成果版本与文件状态。taskId是批次身份；每份新创作成果artifactId是独立UUID，不使用taskId。保存草稿、主级审阅、用户认可和媒体任务成功是不同证据，不互相代替。

## 按角色处理

专业角色（story/assets/shots/audio/voice/review）按本批creative_artifact_save契约保存创作草稿，再交真实成果。主级读取/核对成果并协调接续，不借共享方法直接调用专业保存接口；executor只返回精确命令的实际执行回执，不保存创作草稿、读原文或替用户认可。加载本方法/工作表不会增加工具权限。

## 步骤与判断

1. **核输入与身份。** 读取必要的获授成果，核file、作者、版本、来源、status与needsReview；任务引用必须属于本批范围。草稿dependencies仅用获授或本批已保存成果ID，assetIds仅用本批真实获授素材。依赖先保存并取得回执，不能依赖将来ID、taskId或文件名。
2. **保存最小完整成果。** 专业角色调用creative_artifact_save({artifactId,draft,sources})，使用已有draft类型。sources仅含sourceId/start/end且必须包含于本批实际readRanges；沿旧成果续作但未重读原文时引用旧成果作依赖，不声称本批已读。保存版本、文件、作者与状态由宿主返回，不自己填进工具参数。
3. **核实际保存回执。** 确认artifact.id与本次ID一致，taskId归本批，文件存在且版本/依赖与本次内容对应。回执缺失、错误或未知不当作成功；已有明确回执先复用，不能再次渲染文件或另存到批次ID。
4. **处理重复与修订。** 核对已保存内容优先于重新保存。确需同批原请求重放时，仅同artifactId且draft/sources完全相同才可复用；不能改数组顺序/文本后称相同请求。REQUEST_REUSED表明该ID内容冲突，停止并核对，不能自动换ID掩盖；用户授权的真实修订另用新artifactId，保留旧成果和旧认可，不覆写历史。长标题文件须保留完整UUID与扩展名。
5. **交接本批最终成果。** 已保存时用structured_output({"result":{"artifactId":"实际保存回执ID","summary":"简短说明"}})，只交本批实际产出，并说明已保存依赖与仍待核对项；不重发全文。未保存且接口允许完整draft回传时才走完整draft形式，明确尚未持久保存，不能给计划ID冒充回执。获授旧成果只是输入，不能伪装本批新产出。
6. **主级核对与接续。** 主级核真实文件/版本/作者/来源、状态、needsReview、依赖和实际范围，区分可继续部分与需决定部分。needsReview可能因来源新版本或依赖拒绝/缺失而出现，报告影响并规划必要复核；不自动改旧成果或换依赖。只有真实用户认可/拒绝才进入creative_artifact_decide，主级自检不算用户决定。
7. **中断保留事实。** 已存成果保留，未完成项写明缺口；executor按原命令顺序报告成功/失败/未知回执及真实节点/素材/任务ID，不把错误结果改为completed。主级先核原批次回执和输入，不重派旧/失败/中断批次，不自动重提付费生成。

需要分段保存、重复请求、修订或部分失败交接时，按需读取[成果交接工作表](references/artifact-handoff-workbook.md)。

正例：批次T保存A，B依赖真实A并保存成功；最终交接B和简短摘要，主级按B的原回执读取。反例：将B全文再用T存一遍、把获授旧A冒充本批结果、自动把新版本标认可，或执行者用节点ID假造创作成果。

交付：专业角色交本批最终成果真实ID与摘要；主级交核对结果、实际依赖及必要接续；executor交精确执行回执。保留来源/版本证据、未完成项与待用户决定项，不把内部推理、整部原文或凭据写进交接。

检查：artifactId与taskId独立；内容和sources匹配原请求；文件身份完整；结果确实属于本批；来源/依赖/素材获授且真实；status/needsReview与用户认可分开；保存、节点准备和生成结果不混用。

阻塞：回执未知、文件失踪/身份不符、未读引用、ID冲突、版本或依赖待复核时停在受影响成果，报告已核事实与下一步所需证据。保留成功项，不猜成功、不补写历史、不绕过权限或自动重派。
