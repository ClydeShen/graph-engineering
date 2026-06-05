---
name: defense-in-depth
description: 安全关键路径需要多层防护：编译期类型约束 → 运行时异常 → HTTP 入口拒绝策略
metadata: 
  node_type: memory
  type: lesson
  tags: 
    - security
    - architecture
    - typescript
  created: 2026-06-03T00:00:00.000Z
  status: active
  confidence: high
  originSessionId: 9e5694c0-52b6-4763-8711-2bb249ea72b9
---

## 教训

对于安全敏感路径，"类型通过 ≠ 安全"。TypeScript 编译期约束是第一道防线，不是最后一道。需要同时部署三层防护。

## 三层防护模型

| 层次 | 机制 | 防止 |
|------|------|------|
| 编译期 | TypeScript 类型约束（ReadOnlyGraphHandle） | 无意识的直接调用 |
| 运行时 | SecurityException 抛出 | `as any`、反射等类型绕过 |
| 系统入口 | Gateway 409 拒绝策略 | 外部非法状态下的新事件写入 |

## 反面案例（graph-native-runtime D4 + ADR 39）

Tool → `write()` 约束只有编译期类型检查，`as any` 可以完全绕过。D6 修复后发现 `suspended` 状态在 DB 层有效，但 Gateway 仍接受新事件，触发 OOM 无限循环——单层 DB 防护不够，入口层也必须拒绝。

## 应用规则

每次设计安全约束时，问："如果攻击者控制了这一层，下一层能拦住吗？"对关键路径（写入图、绕过读写隔离、挂起状态下继续执行），三层都要到位。缺任何一层都是可利用漏洞。
