---
name: canvas-execution-manifest-planning
description: Build exact authorized canvas execution manifests. Use before any write delegation, not free-form creative instructions.
---
# 精确执行清单

## 适用与输入

任何画布写入委派前使用。输入：用户精确目标与授权、已保存专业成果、当前canvas_inspect/revision、有效模型选择、真实节点/素材及promptReferences。主级先把创作决定落实为完整参数，执行者只按清单执行；缺专业判断交对应作者，不让执行者补选素材、改prompt或决定模型。

## 编制步骤

1. **读当前基准**：核对真实画布、用户控制、目标节点、现有prompt/参数/引用与获授素材。已存artifactId标明规格依据，但不凭文档显示名当nodeId/assetId；人工修改后先比对新目标，不能旧稿覆盖新内容。
2. **逐项确定变化**：每项写目标、要改字段、保持项和依赖。更新仅写实际需要的patch字段；需要修改prompt/references时同次写真实边和对应token，保留仍需要的原引用。不传无关旧参数或用空值清掉未指定内容。
3. **使用真实调用形状**：批次字段为operationId/task/commands/artifactIds，按需executionMode与allowTts；每项是`{tool,input}`，input内有独立operationId、revision及该工具完整参数。只使用工具目录中的共享契约，不增加临时manifest字段、任意工具、占位UUID或外部job/REF编号。
4. **固定真实媒体输入**：references逐项为source/assetId，prompt使用对应`{{asset:实际UUID}}`并说明用途；模式/firstFrameId/lastFrameId不代替连线。必要人物、服装、场景、道具和适用音色按实际模型预算核对，派生分镜读取其生成当时原始依赖。缺ID或超限退回协调，不猜素材或静默删必要输入。
5. **排出读写依赖**：共同读取同一已存素材可以独立；共同写节点、改上游、导入后引用或需要新建节点回执则有依赖。当前create契约不接受自定nodeId，后项需要新nodeId/assetId时先执行前项、核对真实回执，再准备后批；serial也不能把未来结果占位符变为真实ID。
6. **选执行方式**：多个已确定且无本批引用/布局锚点依赖的新节点用canvas_execute默认auto分给最多4个真实实例。用户明确顺序用executionMode=serial；单项、混合或本批依赖保持顺序。其他独立任务用canvas_execute_parallel，tasks各为完整批次，dependsOn引用同组前置批次operationId；宿主只启动已完成前置的分支，不能指向成果/节点ID。
7. **复验并核对原身份**：提交前复验revision/epoch、精确授权、有效模型及相关资源指纹；普通编辑仅由宿主在相关指纹未变时重基，付费生成保持原快照。批次ID与每项ID唯一且稳定；原key/input先核对回执，未知、失败或中断时不通过换ID重派原批次。

## 工具与授权选择

| 工具 | 清单必须确定的内容 | 不能借此做的事 |
| --- | --- | --- |
| canvas_create_node | 类型、标题、完整prompt、实际模型/支持参数、已有引用及需要的布局 | 自定未来nodeId、自动生成图片/视频 |
| canvas_update_node | 实际nodeId、精确patch、需要同步的references | 覆盖未指定字段、替换历史媒体身份 |
| canvas_connect | 实际source/target/assetId | 用最新输出猜原素材；用单独连线掩盖prompt未同步 |
| canvas_import_attachment | 实际attachmentId、媒体类型、用户指定用途 | 把反馈截图默认当生成参考 |
| canvas_generate | 已有FishTTS节点和本轮精确授权 | 图片/视频生成；自改allowTts=true |

新视频支持开关时默认generateAudio=true。仅真实用户明确无声的精确节点或新建operationId，经canvas_confirm_video_mute绑定后才可false；“不要音乐”不等于无声。无固定音色、无音频参考、无对白或独立TTS都不构成静音理由。无开关模型不塞该字段，旧false任务不迁移。

FishTTS清单核对当前声音/参考、新朗读文本、数量与授权；allowTts只能依据已有用户决定，不由执行者自改。ID与单参考音频互斥，reference_text为参考真实原文，TTS prompt无媒体token。图片/视频准备完成交主级canvas_handoff_generation，用户点击生成。

复杂依赖、patch及部分回执按需读取[执行清单工作表](references/execution-manifest-workbook.md)；表内证据/保持项放task说明，不能当额外API字段提交。

## 交付与阻塞

交付完整commands、实际来源artifactIds、依赖和执行方式、TTS是否获授、预期每项回执与未决。回执按原命令顺序核对tool/input.operationId、实际nodeId/taskId和revision；全部有实际回执才说明整批完成。缺失项交回主级核对，已有成功项不重复。

检查批次/命令ID唯一、输入符合当前工具契约、patch仅含授权变化、引用与prompt同次对应、未来ID已实际产生、模型/声音/TTS决定有效。检查原回执后才判断缺失范围，不以完成自述替代实际结果。

缺权限、模型、真实输入、专业规格、无声依据或当前控制时只阻塞相关范围。不以删除旧任务、替换UUID、重提付费生成或执行者自行补参数来恢复。
