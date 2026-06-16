---
name: feedback_sync_before_writing_code
description: "User wants a sync/alignment checkpoint before any code is written, not after"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 69bb40cc-e7e5-4832-85b8-97874d2f8472
---

写码前先跟用户同步方案再动手（2026-06-15，build-out 绑 execute_bash 中途提出）。

**Why:** 用户要在落码前确认设计选择/范围，避免我擅自往前冲后才发现方向偏差。与 [[feedback_reanchor_on_original_design_when_drifted]] 同源：先对齐再执行。

**How to apply:** 进入任何写文件/改代码的步骤前，先给出计划（要改什么文件、关键设计选择、验证方式）并等用户确认。纯调研/读代码/刷状态文件不需要，但凡是新增或修改实现代码就要先同步。区别于 [[feedback_live_verification_policy]]（那是验证门控，这是写前门控）。
