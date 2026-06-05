---
name: state-dimension-separation
description: "状态值设计前先问\"哪几个维度\"，维度不同则状态值必须分开；单值多维是状态机崩溃前兆"
metadata: 
  node_type: memory
  type: lesson
  tags: 
    - state-machine
    - architecture
    - database
  created: 2026-06-03T00:00:00.000Z
  status: active
  confidence: high
  originSessionId: 9e5694c0-52b6-4763-8711-2bb249ea72b9
---

## 教训

状态机设计时，单一状态值不能承载来自不同维度的语义。设计任何状态枚举前，先列出所有维度，再为每个维度独立设计状态值。

## 反面案例（graph-native-runtime D6）

`terminated` 同时表达了"执行线程物理死亡"（执行维度）和"因果拓扑可以收敛"（拓扑维度）。Watchdog SQL 信任 `terminated`，对 OOM 挂起的 scope 发出了 `scope_closed`，触发跨 scope 全局决策塌方。

正确区分：`terminated` = 执行线程结束，`suspended` = 拓扑未收敛（阻断 Watchdog）。

## 延伸：状态机边界要贯穿全系统

状态值修正（`suspended`）只是第一步。`suspended` 状态还必须在 HTTP 入口层体现为拒绝策略（Gateway 409），否则新事件写入会触发新的 OOM，形成无限循环（ADR 39 Suspended Lockout）。

## 应用规则

遇到状态枚举时，问："这个状态值是否被多个子系统消费，且每个子系统对它的解读方向不同？"如果是，拆成多个维度独立的值，并检查每个维度的状态是否在全系统（DB → 业务逻辑 → HTTP 入口）一致执行。
