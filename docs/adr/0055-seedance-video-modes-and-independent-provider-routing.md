# ADR-0055：Seedance 视频模式与独立供应商路由

状态：已采纳

手动文生视频选择由[ADR-0056](0056-seedance-mode-inference-from-references.md)替代，其余条款保持。

文档类型：解释；负责人：项目维护者 / 开发执行者；最近核对：2026-10-28。
记录日期：2026-10-28。新增视频能力或供应商契约变化时复核。

## 背景与驱动因素

1. 用户要求接入Doubao / Dreamina Seedance 2.0、mini、fast与2.5八款视频模型。标准版支持ByteDance / Model Link，NSFW版本仅BytePlus，鉴权相互独立。官方接口发送用户配置的EP，Model Link发送Model ID；画布和任务中心必须保留可理解的模型名称 / ID。

2. 本轮仅接入文生视频、混合参考生视频和首尾帧生成，暂不接入视频编辑、修改、延长或样片。Seedance 2.0+的首尾帧和混合参考互斥，需要显式的生成模式及图片角色。

## 决策

- 追加十二个稳定模型 / 渠道UUID，保留原十八个身份。具体型号与能力见[协议参考](../providers.md#seedance能力与供应商)，禁止NSFW / 标准渠道串用。
- 复用Seedream的独立Key和可选endpoint_id。ByteDance / BytePlus完整配置要求Key与EP，Model Link只填Key；UI显示逻辑name / model_id，EP只在设置和请求中使用。接受任务时固定原配置与Vault版本。
- 参数增加可选videoMode=text/reference/frames、firstFrameId、lastFrameId、generateAudio。默认文生视频、720p / 16:9、5秒、单条和同步音频。能力为派生数据，不回填旧节点。
- 节点底部在模型旁提供模式下拉，参数弹层不重复模式选择。文生视频不接受素材。参考模式接入图片 / 视频 / 音频，按型号分别限制数量、格式和时长。首尾帧最多两图，按连接顺序默认第一张为首帧、第二张为尾帧，缩略图顶部显示用途，可切换角色且另一图同步交换；同图不可承担两个角色。一图为首帧，移除后剩余图自动作为首帧。2.5首尾帧比例跟随首帧。模式切换若现有入边不符合要求则拒绝，保留草稿与连线；再次选择当前模式不清除分配。
- 连线、上传后连接、@自动引用、图保存与生成提交执行相同模式限制。引用保持具体assetId，不按最新结果自动替换。历史面板显示当次模式、帧分配和媒体类型，只读查看。
- 复用Host持久任务队列：POST创建，GET查询原ID，至少间隔3秒；没有有效ID的提交失败且不自动重提，查询临时故障继续原查询，外部失败 / 取消 / 过期显示失败。沿用既有失败感叹号和Beam / Orb。
- 模型提交前逐份流式读取固定OSS对象，校验hash、实际图片尺寸和音视频时长 / 编码 / FPS，仅使用一个受限临时文件，不把所有视频读入内存。全部校验完成后重新签名24小时链接，发送image_url / video_url / audio_url与相应role。参考准备失败不置issued，不发送模型请求。
- 成功视频URL不携带模型密钥下载；复用暂存、同输出ID与OSS发布 / 重试。URL不替代数据库Object Key，不增加本机永久媒体库。

## 备选方案

| 方案 | 评估 |
| --- | --- |
| 所有输入放在同一模式且无角色标记 | 无法区分混合参考与帧生成，拒绝 |
| 用EP作为节点 / 任务型号名称 | 用户无法识别型号，拒绝 |
| 对所有参考使用原图片总字节预算与Base64 | 无法合理支持视频参考且造成大内存聚合，拒绝 |
| 独立模式下拉、按连接顺序默认角色 / 可调整、固定任务与流式检查 | 满足交互与恢复约束，采用 |

## 后果

正面：八型号按独立渠道配置，帧角色明确，任务可恢复原查询，流式参考避免视频内存聚合。负面：准备阶段增加OSS读取与解码耗时，依赖本机原生解码器和云端模型权限。

## 可逆性与重审条件

不改变SQLite schema 3、23表 / DDL或CanvasGraph存储结构，不清理历史，不重提旧任务。新参数保存在原JSON字段；已经保存Seedance节点或快照后不能用不支持协议的旧包读取全部内容。安装失败且没有新增业务时可恢复本轮停机备份与0.2.49核验包；不得回滚覆盖安装后新任务。

真实EP部署的型号、账户权限、NSFW能力及模型效果仍由用户联调。检查多媒体会增加任务准备时间和OSS读取量；单文件图30MiB、视频200MiB、音频15MiB，原上传maxMediaBytes仍有效，宿主并发保持原设置。真实长时负载 / 磁盘预算待实测。

## 验证与证据

2026-10-28读取用户提供的[BytePlus创建](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api) / [查询](https://docs.byteplus.com/en/docs/modelark/get-video-generation-task-api)、[Model Link创建](https://apidoc.modellink.online/457533828e0) / [查询](https://apidoc.modellink.online/457533829e0)。ByteDance内网页面为应用外壳，以[公开同协议文档](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)交叉核对，不声称内网页面正文已读取。

[目录](../../src/shared/modelCatalog.ts)、[共用校验](../../src/shared/seedance.ts)、[引用检查](../../src/host/media/seedanceReferences.ts)、[适配器](../../src/host/providers.ts)、[帧分配](../../src/client/SeedanceFrameRoles.tsx)及[自动化](../../tests/seedanceModels.test.ts) / [UI回归](../../tests/seedanceModelsUi.test.tsx)提供实现证据；安装与包身份见本轮manifest，用户验收见[清单](../manual-tests.md)214–219。供应商契约、参考限制、模型版本或新增编辑能力变化时重审。
