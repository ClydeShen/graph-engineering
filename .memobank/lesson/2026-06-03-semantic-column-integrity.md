---
name: semantic-column-integrity
description: 存储层物理列值必须忠实承载语义，不能用 payload 内部字段代替一等公民列值
metadata: 
  node_type: memory
  type: lesson
  tags: 
    - storage
    - schema-design
    - event-sourcing
  created: 2026-06-03T00:00:00.000Z
  status: active
  confidence: high
  originSessionId: 9e5694c0-52b6-4763-8711-2bb249ea72b9
---

## 教训

存储层的物理列值必须忠实承载高层语义。禁止将语义类型"压进"payload 字段并让 DB 列统一存低层通用值。

## 反面案例（graph-native-runtime D1）

把 `task_spawned` 降维存成 `memory_updated`，真实语义只在 `payload.event_type` 区分。Phase N+1 的查询面（BM25+RRF 检索、ConflictResolver、`WHERE event_type = 'task_spawned'`）直接失明，且没有编译期报错。用户称之为"因果降维泄露漏洞"。

## 应用规则

每次设计 DB 写入路径时，问："这个列值是否真实反映了提交者的意图？还是被为了省事统一成了通用值？"如果语义差异只在 payload 内部区分，这是警告信号——把它提升为一等公民列值。

**修复代价：** ADR 40 — OCC_WRITE_SQL 加 $5 event_type 参数，10 行改动，影响所有调用点。越晚修代价越高。
