---
name: canvas-execution-receipts
description: Reconcile exact operation receipts and blocked execution. Use after writes or interruption, not replaying unknown batches.
---
# 执行回执核对

输入：原commands、稳定operationId与实际工具/宿主回执。按原命令顺序整理tool、operationId、实际nodeId/taskId、revision和缺失项。

completed只在全部命令取得实际回执时成立；结构化自述仅建议。未知/失败/中断批次先查询原key/input和原任务，不新建ID重派、不重提付费生成。

例：三项操作有两条回执，交blocked并列第三项缺口；不能因为图中似乎有节点就声称第三项已提交。任务已接受但返回中断时读取原任务身份，不重复生成。

交付structured_output的status/summary与真实回执；专业成果artifactId和批次taskId分开，不将任务ID当新成果ID，不生成同内容文档来冒充交接。

检查实际参数/引用、命令顺序、版本、原ID和取消状态。重连/后台恢复只观察已有状态，不重放点击或旧动作；成功项保持，缺失项由主级核对决定后续。
