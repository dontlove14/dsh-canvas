# 成果交接工作表

用于专业保存、主级核对与executor执行回执交接。教学字段不增加工具参数或权限；executor只读获授成果并交精确命令回执，不保存创作draft、不读原文、不替用户认可。

## 1. 本批身份与输入

```text
角色 / projectId / taskId：
本批交付终点：
获授artifactIds / sourceIds / assetIds：
旧成果file / author / version / status / needsReview：
本批真实readRanges：
计划依赖及其实际保存回执：
```

仅专业保存接口使用的参数：

```text
creative_artifact_save({
  artifactId: 独立UUID（不等于taskId）,
  draft: 现有draft类型和字段,
  sources: [{sourceId, start, end}] // 仅本批真实读过范围
})
```

dependencies写在draft中，仅使用获授或本批已存成果ID；assetIds为真实获授素材。file、version、author、status由宿主返回，不添加到保存参数。据旧成果续作未重读原文时，以旧成果作依赖并说明依据，sources不冒填。

## 2. 保存回执核对

| 内容 | 实际回执证据 | 判断 |
| --- | --- | --- |
| artifact.id / taskId | 对应本次独立ID及本批 | 计划ID/批次ID不算 |
| file / version / author | 原回执和获授读取核验 | 文件名保持UUID/扩展名 |
| draft / sources / dependencies | 对应本次内容和真实范围 | 不能抄未读原文引用 |
| status / needsReview | 原始返回状态与变化原因 | 草稿不等于认可 |
| 未完成项 | 缺页、缺决定、缺回执等 | 不隐藏、不改成成功 |

同批原请求只有artifactId及draft/sources完全相同才可复用，已有明确回执优先使用。REQUEST_REUSED停止核对身份/内容冲突；授权修订另用新ID，旧成果和旧认可保留。

## 3. 专业最终交接

已保存时沿现有结构：

```text
structured_output({
  result: {
    artifactId: 本批最终成果的实际保存回执ID,
    summary: 简短说明本批完成项、已保存依赖与必要缺口
  }
})
```

不重复全文、不交获授旧成果冒充新产出、不把本批依赖结果都改成taskId。仅尚未保存且完整draft回传接口允许时才返回完整draft，明确未持久保存；不能返回计划artifactId声称保存成功。

## 4. 主级接续与执行回执

```text
主级已核成果：file / version / author / sources / dependencies：
status / needsReview / 受影响范围：
可复用项 / 仍需复核项 / 用户必要决定：
用户原认可/拒绝及其精确成果（如有）：
executor：按原顺序逐命令真实回执：
  tool / 操作ID / 成功、失败或未知 / 真实nodeId、assetId、taskId：
仍未完成项及最后已核事实：
```

主级自检不调用用户认可接口；needsReview不触发自动换依赖、改旧稿或重新生成。executor不把节点、媒体任务或命令ID当创作artifactId；主级核原批次输入/回执，不重派旧批次。

## 5. 正反例

以下字母代表教学身份，实际必须使用真实UUID与回执。

**分段保存。** 批次T保存A，再保存依赖A的B；B回执含独立ID、文件、版本与本批taskId。最终只交B与摘要“A为已存前段依据”。反例：B保存后重新输出全文让主级再用T保存一次。

**重复请求。** A已明确保存，直接复用A回执；确需重放时保持原ID与完全相同draft/sources。若正文已有改动，先判定是否为授权修订再用新ID，不能吞REQUEST_REUSED并循环换ID。

**旧成果续作。** 本批获授A但未读原文，产出B.dependencies=[A]、sources=[]，正文注明依据A；最后交B。反例：交旧A当本批结果，或复制A全书sources称本批已读。

**版本与认可。** A已认可，B是新修订草稿，A保留认可、B等待真实用户决定。来源更新使某成果needsReview=true时主级报告影响并规划复核，不能把旧认可清空或新稿自动标approved。

**部分失败。** executor三命令中两项有成功回执，第三未知；如实按顺序交两项真实ID与第三缺口。反例：猜第三成功、改state为completed，或自动重派原批次/生成。

**长文件名。** 标题可在展示时缩写，但文件真实UUID和扩展名完整，读取以实际file/ID为准。反例：重新拼截断UUID路径或重新渲染“同名”成果。

## 6. 结束检查

- 批次、成果、节点、媒体任务各保留独立真实身份。
- 本批最终结果已保存且有回执，来源范围/依赖/素材符合本批授权。
- 草稿、主级审阅、用户认可、技术成功分别有证据；未知/失败不混为completed。
- 重复保存复用原内容，授权修订保留旧稿；不重复渲染或重提任务。
- 交接只含公开事实、必要来源与摘要，不包含隐藏推理、整部原文或凭据。
