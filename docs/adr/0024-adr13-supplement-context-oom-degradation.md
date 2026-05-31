# ADR 13 补充：拓扑视界宽度熔断三级降级链路

status: accepted  
日期: 2026-05-31  
补充对象: ADR 13（Knapsack Slicing）

---

## 上下文

ADR 13 规定当 `W_core > W_max` 时执行宽度熔断，仅注入 `N_root + N_current`。但未处理以下极端情况：`Size(N_root) + Size(N_current)` 本身已超过 `W_max`（例如 N_root 携带大型结构化需求说明，N_current 携带巨型反思 payload，而物理窗口 W_physical 较小）。

此时若静默失败或抛出异常，大模型调用会产生不可预期的 OOM 错误，并可能导致 Worker 崩溃写入格式不合规的 `conflict_detected` 节点，污染图账本。

---

## 决策：三级自适应降级链路

当宽度熔断后 `Size(N_root) + Size(N_current) > W_max` 时，依序触发：

```
[W_core > W_max，宽度熔断后仍超限]
       │
       ▼
【一级自适应防护】N_root 战略意图就地蒸馏
       │ (若仍超限)
       ▼
【二级自适应防护】N_current 尾流截断
       │ (若仍超限)
       ▼
【三级刚性熔断】控制面注入 context_oom_throttled，Scope 挂起
```

---

### 第一级：N_root 战略意图就地蒸馏（Distillation）

**触发条件**：`Size(N_root) + Size(N_current) > W_max`

**原理**：`N_root`（`plan_created`）携带的完整用户原始意图文本通常冗余度高。将其压缩至核心三要素可释放大量 Token 空间。

**动作**：
- 由 iii-engine 网关层调用 `EmbeddingProvider` 配套的轻量推理模型（ADR 22，⚠️ **LLM 调用点**，要求本地可运行，如 Llama-3-8B / Qwen-1.8B / 同等小参数模型）
- 对 `N_root.payload` 执行硬性结构化摘要，保留：
  ```
  Core Goal:           <一句话核心目标>
  Hard Constraints:    <不可违反的约束列表>
  Final Output Format: <期望输出格式说明>
  ```
- 目标：将 N_root 体积压至原始的 10%–20%
- 蒸馏后的摘要替换注入内容中的 N_root，原始 N_root 仍完整保留在图账本（append-only 不变）

**若蒸馏后 `Size(N_root_distilled) + Size(N_current) ≤ W_max`**：进入正常 Worker 调用，在 `_meta` 中标注 `context_pressure: "level_1_distillation"`。

---

### 第二级：N_current 战术荷载尾流截断（Tail Truncation）

**触发条件**：一级蒸馏后仍超限

**原理**：N_current（如大型反思或巨型代码片段）的头部通常是历史中间日志，尾部是最新执行状态、错误抛出尾流、直接返回值——对 Worker 而言尾部信息价值更高。

**动作**：
- 对 `N_current.payload` 执行流式 Token 扫描（Wasm Tokenizer，ADR 15）
- 强制保留尾部 `min(2000, W_max - Size(N_root_distilled))` 个 Token
- 头部截断区域替换为旗标：`[...Byte-Level Truncated: {truncated_tokens} tokens omitted...]`
- 在 `_meta` 中追加 `context_pressure: "level_2_tail_truncation"`

**若截断后 `Size(N_root_distilled) + Size(N_current_tail) ≤ W_max`**：进入正常 Worker 调用。

---

### 第三级：控制面刚性熔断（Hard Kernel Fuse）

**触发条件**：经一、二级压缩后仍无法满足 `W_max`（极端场景：物理窗口极小）

**动作**：
1. 底座彻底阻断大模型调用请求，不产生任何 LLM 调用
2. 控制面守护线程（ADR 05）直接向当前 Scope 分区子表写入内核级事件：

   ```sql
   INSERT INTO execution_event_log_scope_{id} (
     entity_id, event_type, predecessor_hash, scope_id, payload
   ) VALUES (
     $current_entity_id,
     'context_oom_throttled',          -- 控制面直写，不经总线枚举校验
     $current_version_hash,
     $scope_id,
     '{
       "suspended_at": "<timestamp>",
       "w_max": <w_max>,
       "n_root_tokens": <n>,
       "n_current_tokens": <n>,
       "distillation_attempted": true|false,
       "tail_truncation_attempted": true|false,
       "resolution": "awaiting_intervention"
     }'
   );
   ```

3. 当前 Scope 进入 **Suspended（挂起）** 状态，拓扑收敛看门狗（ADR 19）在检测到未解决的 `context_oom_throttled` 时阻断 `scope_closed` 判定
4. 向 iii-observability 发送最高级告警，等待人工干预（扩大物理窗口 / 分拆任务 / 降低 payload 体积）

**`context_oom_throttled` 事件规范**：
- **写入者**：控制面守护线程（唯一合法源头，与 `scope_closed` 同级权限）
- **不经过**：总线事件类型枚举校验（见 ADR 12 补充声明）
- **不触发**：任何 Worker 订阅路由
- **解除条件**：人工干预后，控制面写入后续事件重新激活 Scope

---

## 与现有 ADR 的关系

| ADR | 交互 |
|-----|------|
| ADR 12 | `context_oom_throttled` 是控制面直写事件，不加入五大法定认知事件枚举；ADR 12 补充声明此例外 |
| ADR 13 | 本文档是 ADR 13 宽度熔断逻辑的精确化补充 |
| ADR 15 | 第二级尾流截断使用 Wasm Tokenizer 精确计算截断点 |
| ADR 19 | 拓扑收敛看门狗感知 `context_oom_throttled`，阻断 `scope_closed` 直至解除 |
| ADR 22 | 第一级蒸馏为 ⚠️ LLM 调用点，使用轻量推理模型，通过 LLMProvider 接口执行 |
