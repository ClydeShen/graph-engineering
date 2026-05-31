# ADR 23｜嵌套 Scope 与子 Scope 关闭传导协议

status: accepted（Phase 3 实现，Phase 1 前向兼容预埋）
日期: 2026-05-31

---

## 上下文

RFC §3 提及子 Scope 通过 `child_of` 边连接父 Scope，子 Scope 关闭事件向上传导。但该描述未覆盖具体实现机制，且与 ADR 12（法定事件枚举）、ADR 05（控制面 DDL 专权）存在潜在冲突。

本 ADR 在以下约束下完整定义嵌套 Scope 机制：
1. 不扩展 ADR 12 的五大法定认知事件枚举
2. 控制面保持纯基础设施角色，不写业务语义行
3. 父 Scope 内 Worker 对子 Scope 物理存在完全无感

---

## 决策

### Phase 1：前向兼容预埋（不激活嵌套逻辑）

`task_spawned` payload 允许携带 `spawn_sub_scope: true` 字段，Phase 1 总线静默忽略此字段，不触发任何子 Scope 创建逻辑。

```json
{
  "event_type": "task_spawned",
  "payload": {
    "intent": "对大型子任务执行独立 Scope 隔离",
    "spawn_sub_scope": true,
    "_meta": { "tokens": { "model_x": 80 } }
  }
}
```

Phase 1 Worker 无需感知此字段，Phase 3 激活时无需修改 Worker 代码。

---

### Phase 3：完整嵌套 Scope 机制

#### 1. `child_of` 关系：控制面元数据，不是业务边

Worker 不产生 `child_of` 事件。控制面拦截带 `spawn_sub_scope: true` 的 `task_spawned` 后，在三阶段筑巢协议（ADR 05 升维）的 DDL 强事务中，原子写入全局元数据冷表：

```sql
CREATE TABLE scope_lineage (
    child_scope_id   VARCHAR(50) PRIMARY KEY,
    parent_scope_id  VARCHAR(50) NOT NULL,
    trigger_task_id  UUID NOT NULL,      -- 触发子 Scope 的 task_spawned entity_id
    created_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_parent FOREIGN KEY (parent_scope_id)
        REFERENCES scope_lineage(child_scope_id)
        DEFERRABLE INITIALLY DEFERRED    -- 允许根 Scope（无父）存在
);
CREATE INDEX idx_lineage_parent ON scope_lineage (parent_scope_id);
```

`scope_lineage` 是 DDL 元数据冷表，不是事件日志，不受 append-only 约束，不参与 OCC。

#### 2. 子 Scope 关闭：复用 ADR 19 看门狗，不引入新事件

子 Scope 内部遵循完整的 ADR 19 拓扑收敛看门狗协议，最终产生 `scope_closed` 事件（不引入 `system_halted` 或其他新名称）。子 Scope 的关闭流程与独立 Scope 完全相同。

#### 3. 向上传导：三步火炬传递

```
[子 Scope scope_closed 落盘]
       │
       ▼
【步骤 1：归档】子 Scope 执行冷热分离（ADR 06），DETACH 分区
       │
       ▼
【步骤 2：控制面跨分区信号注入】
  控制面读取 scope_lineage，向父分区直写控制面事件：
  event_type = 'sub_scope_resolved'（控制面直写，不经总线枚举校验）
  payload = {
    "child_scope_id": "$S_child",
    "trigger_task_id": "$task_id",          -- 对应父 Scope 中的 task_spawned entity_id
    "child_final_version_hash": "$H_last",  -- 子 Scope 最后一条 memory_updated 的 version_hash
    "child_scope_id_pointer": "$S_child"    -- 父 Worker 可据此查询冷表获取完整结果
  }
       │
       ▼
【步骤 3：SubScopeResultWorker 语义合并】
  SubScopeResultWorker 监听 sub_scope_resolved
  → 读取子 Scope 冷表尾部节点（通过 child_final_version_hash）
  → 调用 LLM（⚠️ LLM 调用点，ADR 22）合成结果摘要
  → 向父分区写回标准 memory_updated：
    payload = {
      "sub_scope_resolved": "$S_child",
      "result_summary": "...",
      "child_final_version_hash": "$H_last"
    }
  → 父 Scope 拓扑继续推进，任务节点标记 completed
```

#### 4. `sub_scope_resolved` 事件规范

与 `context_oom_throttled` 同级（ADR 13 补充）：
- **写入者**：控制面守护线程（唯一合法源头）
- **不经过**：总线事件类型枚举校验
- **触发路由**：总线感知到此事件后，激活 `SubScopeResultWorker` 订阅
- **父 Worker 无感**：父 Scope 普通 Worker 不订阅此事件类型

#### 5. 父 Scope 拓扑完整性

父 Scope 看门狗（ADR 19）在 `task_spawned` 中检测 `spawn_sub_scope: true` 时，将对应任务标记为"等待子 Scope 信号"——在 `sub_scope_resolved` 信号到达并产生对应 `memory_updated` 之前，该任务不计入 `completed_tasks` 计数器。

---

## SubScopeResultWorker

专职子 Scope 结果合并器。被 `sub_scope_resolved` 事件唤醒，启动独立 Context Window：

1. 从冷表读取子 Scope 尾部节点（`child_final_version_hash` 定位）
2. 调用 LLMProvider（ADR 22）合成结果摘要
3. 向父分区写回标准 `memory_updated`，predecessor_hash 指向父 Scope 中对应的 `task_spawned` 节点
4. 处理完即销毁 Context Window

---

## 后果

- ADR 12 五大法定认知事件枚举保持不变
- 控制面维持纯基础设施角色：写入 `sub_scope_resolved` 是信号注入，不含业务语义
- 业务语义合成（result_summary）由 SubScopeResultWorker 完成，LLM 调用留在 Worker 层
- 父 Scope Worker 对子 Scope 物理存在完全无感，只感知 `task_spawned → memory_updated` 的正常推进

## 关联 ADR

- **ADR 05** — 筑巢协议升维：DDL 事务中原子写入 `scope_lineage`
- **ADR 06** — 子 Scope 关闭后复用冷热分离归档
- **ADR 12** — `sub_scope_resolved` 是控制面直写事件，不加入枚举（同 `context_oom_throttled`）
- **ADR 19** — 父 Scope 看门狗感知 `spawn_sub_scope` 标记，持有等待锁直至 `sub_scope_resolved` 信号
- **ADR 22** — SubScopeResultWorker 的 LLM 调用通过 LLMProvider 接口
