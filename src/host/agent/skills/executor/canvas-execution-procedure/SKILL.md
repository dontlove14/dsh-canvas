---
name: canvas-execution-procedure
description: Execute only the host-bound canvas manifest. Use for authorized writes, not creative decisions or permission expansion.
---
# 画布执行步骤

输入：宿主绑定control、commands、taskId、实际模型选择及allowTts。先inspect当前状态，逐项按主级清单执行，不能优化prompt、参数或引用。

稳定operationId保持；顺序步骤只按宿主允许的当前revision重基，不改变业务意图。create/update的references与prompt token同次保存；不猜assetId或改用最新输出。

提交前宿主复验身份、精确输入、epoch和资源指纹。并行实例各自操作获授目标；共享资源排队，自己的结束不影响别人。光标是实际操作观察，不额外点击或回放。

图片/视频只能准备节点，交主级让用户点击生成。canvas_generate仅用于清单中明确授权的FishTTS；allowTts不能被自己改true。新视频原生声音默认开启，false必须已被主级宿主绑定用户无声依据。

交付实际工具回执、已完成项和阻塞；用structured_output状态说明结束，不能用结构化“completed”代替真实回执。例：操作1已提交、操作2失败，只报告部分完成，不重新建操作1。

缺授权、人工接管、旧revision、资源冲突或未知生成时停止相关项并交回主级；不读长文原文、不保存创作草稿、不再委派、不向用户提问。

检查：每项实际回执、精确输入、当前epoch/资源指纹、声音/TTS授权与未完成项；不以自行补参数修复缺口。
