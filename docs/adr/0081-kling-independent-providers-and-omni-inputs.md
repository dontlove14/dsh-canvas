# ADR-0081：Kling 独立提供商与 Omni 素材用途

状态：已采纳

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-11-03。
记录日期：2026-11-03。官方与网关鉴权、参数、状态或媒体限制变化时重审。

## 背景与驱动因素

1. 用户要求接入 Kling 4.0，同时支持官方 KlingAI 与 Model Link。二者虽然都使用 Bearer API Key，仍是不同提供商，不能共享密钥、任务身份或自动回退。
2. 当前视频节点只需文生视频与 Omni；Omni 已覆盖图片关键帧和图片参考，不另接图生视频端点，不支持 element / voice，水印使用 false。

## 决策

1. 增加 `kling-video`，在原39个组合之后追加 Model Link / KlingAI 两个稳定 UUID（尾号002b / 002c），每个组合沿现有 Vault 独立绑定 Key。Model Link base 为 `https://api.modellink.online`，KlingAI 使用官方中国区 `https://api-beijing.klingai.com`。官方新 API 直接使用 API Key Bearer，不使用旧 AK/SK JWT。无 EP、共享令牌或自动换渠道。
2. 文生 `POST text-to-video/kling-4.0`，顶层 `prompt`；Omni `POST omni-video/kling-4.0`，`contents` 含 prompt 与有唯一 id 的素材。Model Link 两路径前加 `klingapi/`。共享 settings.duration / resolution / aspect_ratio 和 options.watermark_info.enabled=false，仅共享入参，不共享鉴权或响应适配。
3. 无输入自动文生，连接图片或视频自动 Omni。图片用途为 refer_image / first_frame / middle_frame / last_frame，视频为 feature_video / base_video。默认参考图片 / 特征参考；首帧、尾帧和待编辑视频各最多一份。不使用独立 frames 模式；不存在 element / voice 类型或音频开关。
4. 在既有参数 JSON 增加可选 `klingReferenceRoles:{assetUUID:role}`，最多15项，仅允许匹配当前素材类型的用途。只在引用发生变化时清理已移除素材的用途。复制粘贴继续指向原上游素材并保持用途；任务快照冻结本次用途。无 DDL、CanvasGraph 版本、存量节点或历史数据重写。
5. 画布提示词继续存 `{{asset:UUID}}`，接受任务时按固定引用顺序生成 `@image_N` / `@video_N`，请求 contents.id 使用同一映射。直接文字保持原样，不能把普通 `[参考图N]` 文本误当绑定。原图 token 不改；失效引用继续拒绝。
6. 720p / 1080p、3–30秒、单条输出，默认1080p / 16:9 / 10秒。文生四种具体比例，Omni另有adaptive。英文最多26000、非英文最多11000，混合按两者占比合计≤1；接受和执行前按真实发送文字校验。
7. 图最多10份、JPG/JPEG/PNG、30MiB、宽高至少300px，比例0.4–2.5；视频最多5份、MP4/MOV、300MiB，单段与总时长3–30秒，宽高700–4553px、总像素≤8294400，24–60FPS。合计最多15份。复用原任务的固定OSS版本，每次只流式暂存一份，核对hash / bytes / MIME并读取实际尺寸 / 时长 / FPS，再签24小时URL。没有文档依据的编解码器限制不添加。
8. 官方提交 `data.id`，查询 `GET tasks?task_ids=<id>` 的单元素data数组，状态submitted / processing / succeeded / failed。Model Link提交和查询均为data.task_id，`GET klingapi/tasks/{id}`，状态SUBMITTED / IN_PROGRESS / SUCCESS / FAILURE；两适配器严格核对原ID。查询间隔至少5秒，原Key与提供商在任务接受时固定。未知响应 / 状态不能自动重提；成功后CDN下载不携带Key，失败只恢复原结果保存。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 把两家归为一个 Bearer 提供商 | 账户、Key和任务域不同，拒绝 |
| 另加图生视频模式 | 与Omni关键帧能力重复，用户明确排除 |
| 沿 Seedance 帧模式或请求结构 | 无中间帧 / 视频编辑用途，且协议不同，拒绝 |
| 共用视频节点、独立提供商和响应适配 | 满足范围与恢复约束，采用 |

## 后果

正面：增加可选参数与协议值，无存量迁移，视频节点和原任务恢复继续共用现有流程。

负面：两家响应格式需分别维护；真实账户的Key、模型权限、网关枚举兼容与生成效果仍由用户验收，离线测试不代表账户可用性。

## 可逆性与重审条件

新Kling配置 / 节点 / 快照需要本版本或更新版本读取；已产生新数据后使用前向修复，不覆盖回退到不识别Kling的旧包。官方或网关参数、鉴权和响应变化时重审，由开发执行者维护适配器与离线核验，用户负责真实账户验收。

## 验证与证据

2026-11-03读取官方[文生视频](https://klingai.com/document-api/api/video/4-0/text-to-video)、[Omni](https://klingai.com/document-api/api/video/4-0/video-omni)及其公开文档模块；网关约定来自用户提供的kling4-api.md。官方图生文档仅用于核对重复能力，没有加入实现。

实现：[目录](../../src/shared/modelCatalog.ts)、[参数和用途](../../src/shared/kling.ts)、[协议](../../src/host/providers.ts)、[媒体检查](../../src/host/media/seedanceReferences.ts)。自动化：[协议与持久恢复](../../tests/klingModels.test.ts)、[设置 / 编辑器 / 历史](../../tests/wanModelsUi.test.tsx)、[编译Host产物](../../scripts/verify-artifact.mjs)。人工验收见[清单](../manual-tests.md)384–389；安装与检查证据记录在107manifest。
