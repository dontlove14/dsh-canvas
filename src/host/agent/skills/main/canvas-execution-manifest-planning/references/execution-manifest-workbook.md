# 执行清单工作表

表格用于主级编制task说明和参数核对，不新增API字段。提交时以当前工具目录的`{tool,input}`契约为准；模板ID说明必须替换为真实UUID或实际回执，不能将说明文字直接提交。

## 1. 命令前的证据

| 用户目标 | 当前节点/素材 | 规格依据 | 修改字段 | 保持项 | 所需前置 | 授权状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 本轮精确范围 | inspect真实ID与revision | artifactId/版本 | 精确patch或完整新建参数 | 原prompt/引用/其他参数 | 真实回执或未决 | 当前root/canvas/epoch与用户决定 |

教学：用户只改标题，更新patch只含title，不复制旧prompt/params/references。用户改prompt并新增参考，则prompt与references同次保存，仍需的原引用也保留。

## 2. 真实调用形状

```text
canvas_execute
  operationId：本次独立批次的稳定UUID
  task：目标、依据、保持项、验收与缺口说明
  artifactIds：实际获授规格成果ID
  executionMode：需要时auto或serial
  allowTts：只按精确用户授权
  commands：
    - tool：目录允许的准确工具名
      input：
        operationId：该操作的独立稳定UUID
        revision：当前读到的版本
        该工具的完整支持参数
```

批次operationId与命令input.operationId分别管理，命令ID不可在同批/同组重复。不能写`operationId`在command顶层替代input，不能把“让执行者选一张图”当完整参数。

create没有自定nodeId字段；新节点ID来自实际回执。普通顺序编辑的revision由宿主按相关指纹安全重基，主级不伪造未来revision，不改变业务意图来适配冲突。

## 3. 真实引用核对

```text
当前目标与模型/模式：
每份source节点、真实assetId、prompt token及用途：
必要原始人物/服装/场景/道具/适用音色：
派生素材生成当时的referenceDependencies：
image/video/audio/total实际预算：
首尾帧选择及对应真实边：
确实无关素材的精确原因（若有）：
```

教学：分镜来自旧人物图，源人物节点已显示新图。若目标仍是旧人物造型，按该分镜原依赖的旧assetId准备；不能用最新输出替换历史身份。缺必要图或超限先协调，不用假UUID填表。

## 4. 执行方式判断

| 工作 | 方式 | 理由 |
| --- | --- | --- |
| 多个新视频节点，共用同一已存人物图，无相互布局依赖 | canvas_execute默认auto | 固定只读参考不构成写冲突 |
| 用户明确要求依次创建 | executionMode=serial | 保留用户顺序 |
| 新建A后B需要A的nodeId，或导入音频后引用 | 分批，先核对A/导入真实回执 | 未来ID不能由serial或占位符解决 |
| 多个已确定的独立更新任务 | canvas_execute_parallel | tasks各有完整清单，共享写目标由宿主排队 |
| 同组后分支须等前分支完成 | dependsOn填前置批次operationId | 不是nodeId、artifactId或文字标签 |

dependsOn只保证启动依赖，不提供未来结果模板插值；后分支参数尚缺新ID时仍需前批真实回执后准备。专业与执行共享默认4实例上限，不加自定义调度器。

## 5. 声音与TTS核对

- 新视频有开关时默认true；明确无声才以实际nodeId或新建操作ID绑定用户依据。无音乐只去音乐。
- 没有开关不加generateAudio；旧false任务与旧认可不迁移。
- canvas_generate只用于本轮明确授权的FishTTS节点，allowTts不赋予其他生成权。
- voice ID与一个参考音频互斥；参考原文和新朗读文本分开，prompt不插媒体token。

## 6. 回执表与续作

| 原命令顺序 | tool/input.operationId | 实际nodeId/taskId/revision | 实际结果 | 缺口/下一步 |
| --- | --- | --- | --- | --- |
| 保持原顺序 | 对应原精确输入 | 仅来自回执 | 已完成/未知/失败 | 查询原身份或处理已核实剩余 |

教学：3项中2项有回执，第三项返回中断。先核对原批次输入和原回执，若已有原taskId就查该任务；不能新批次再建前两项或重提第三项。

只把已核实的新修改或未完成剩余范围编成新任务，成功内容复用。全部取得真实回执才说明整批完成；执行者的structured_output自述不代替回执。
