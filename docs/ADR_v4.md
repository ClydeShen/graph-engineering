# 架构决策记录 (Architecture Decision Record - ADR) 权威列表 v4

---

## 第一层：基础存储层

### ADR 01｜核心系统原语：执行图与 PostgreSQL append-only 事件日志
- **状态**: 已通过 (Approved)
- **上下文**: 传统 Agent 系统工作流逻辑分散在各业务代码块中，导致系统高度碎片化。为消灭"一次性工程"，需要一个统一的系统原语，既能沉淀记忆，又能直接涌现出执行控制流。
- **决策**: 将 Execution Graph（执行图）作为系统核心底层原语，物理存储为 PostgreSQL append-only 事件日志表，账本只增不减。内存热图作为运行时拓扑计算层。任何修改和失败都被视为新的"认知事件"向后滚动，捍卫不可变时空轴与单一事实来源（SSOT）。外部数据库（GraphDB、向量库等）或本地文件仅作为索引或缓存适配层。
- **后果**: 控制流不再由人类硬编码的代码主导，执行变成了图在运行过程中由于事件触发而自适应生长的动态结果。

---

### ADR 02｜实体同一性与 Scope 盐化内容寻址模型
- **状态**: 已通过 (Approved) ⚠️ **实现规范修正 2026-05-31**
- **上下文**: 图原生系统中的节点会随任务推进不断更新属性。原地覆写将失去重放调试和因果追溯能力。
- **决策**: 采用混合寻址模型：Entity ID（稳定 UUID）+ Version ID（SHA-256 内容哈希）。规定计算任何节点哈希时，其底层密码学拼接矩阵必须强制将 scope_id 作为物理盐（Cryptographic Salt）灌入首位：

  ```
  $content_input = "{scope_id}|{entity_id}|{predecessor_hash}|{event_type}|{canonical_json(payload)}"
  ```

  Payload 内 Key 严格按字母升序定序、剔除空格换行后以 UTF-8 编码，pgcrypto `digest()` 就地计算哈希，永不可变。

- **⚠️ 实现规范修正（2026-05-31，PostgreSQL 官方文档验证：REFUTED）**

  **`canonical_json(payload)` 必须在应用层（Rust/TypeScript）完成，禁止依赖 `jsonb::text` 转换。**

  PostgreSQL 官方文档明确：`jsonb` **不保证任何特定 key 顺序**，内部使用 length-first（短 key 在前）排序，既非输入顺序，也非字母升序。这是实现细节，不是文档化保证。

  ```sql
  -- 官方文档示例：
  SELECT '{"bar": "baz", "balance": 7.77, "active":false}'::jsonb;
  -- 输出：{"bar": "baz", "active": false, "balance": 7.77}
  -- 排序为 length-first，非字母序
  ```

  **正确实现（Phase 1 强制执行）：**

  ```rust
  // Rust：serde_json + BTreeMap 递归保证 key 字母升序
  fn canonical_json(payload: &serde_json::Value) -> String {
      fn sort_keys(v: &serde_json::Value) -> serde_json::Value {
          match v {
              serde_json::Value::Object(map) => {
                  let sorted: std::collections::BTreeMap<_, _> =
                      map.iter().map(|(k, v)| (k.clone(), sort_keys(v))).collect();
                  serde_json::Value::Object(sorted.into_iter().collect())
              }
              serde_json::Value::Array(arr) =>
                  serde_json::Value::Array(arr.iter().map(sort_keys).collect()),
              other => other.clone(),
          }
      }
      serde_json::to_string(&sort_keys(payload)).unwrap()
  }
  ```

  ```typescript
  // TypeScript：递归 key 排序
  function canonicalJson(payload: unknown): string {
      if (Array.isArray(payload)) return JSON.stringify(payload.map(canonicalJson));
      if (payload && typeof payload === 'object') {
          const sorted = Object.fromEntries(
              Object.keys(payload as object).sort()
                  .map(k => [k, JSON.parse(canonicalJson((payload as Record<string,unknown>)[k]))])
          );
          return JSON.stringify(sorted);
      }
      return JSON.stringify(payload);
  }
  ```

  PostgreSQL 侧接收已规范化的 `TEXT`，直接参与 `digest()` 拼接，**不做二次 `::jsonb` 转换**。

  **两阶段哈希契约（Phase 1 强制执行）**：

  | 阶段 | 执行者 | 职责 |
  |------|--------|------|
  | 阶段一：Payload 规范化 | 应用层（Rust/TypeScript） | 对 payload 对象执行 BTreeMap 递归排序序列化，产出不可变 TEXT 字面量，且只做一次 |
  | 阶段二：哈希计算与重算 | PostgreSQL 事务内核 | 将应用层传入的 `canonical_json_text`（TEXT）与 `scope_id`、`entity_id`、`predecessor_hash`、`event_type` 拼接后执行 `digest()`。Writable CTE 因果倒置路径中，`predecessor_hash` 改写为胜者哈希后，PostgreSQL 用**同一份 `canonical_json_text` 字符串**重新拼接并 `digest()`，不回调应用层，不做 `::jsonb` 转换 |

  核心不变量：**canonical_json_text 一旦离开应用层即为字面量常数，任何后续哈希重算均在 PostgreSQL 内用此常数直接参与字符串拼接。**

- **后果**: scope_id 盐值将跨 Scope 哈希碰撞的物理概率降至 SHA-256 碰撞概率级别，实现密码学层与数据库物理层的双重防脏写。图运行中产生的死胡同分支作为"孤岛节点（Orphan Nodes）"留在历史中，成为系统反思避免再次踩坑的证据。

---

### ADR 03｜乐观并发控制：Writable CTE 原子因果倒置
- **状态**: 已通过 (Approved)
- **上下文**: 多 Worker 高并发场景下，多个独立 Context Window 可能在同一绝对秒内同时尝试升级同一图节点，导致写冲突。应用层先查后写存在竞态窗口。
- **决策**: 彻底放弃应用层先查后写的脆性逻辑。利用 `UNIQUE(predecessor_hash, scope_id)` 唯一索引作为物理防线，在单次数据库 I/O 环路内利用 Writable CTE 配合条件连接执行原子裁决：
  - **先到者（正统写入）**: `event_type = 'memory_updated'`，predecessor_hash 指向基准节点
  - **落后者（因果倒置）**: 触发冲突后，原子降级为 `event_type = 'conflict_detected'`，predecessor_hash 强制改写指向胜者，payload 保留 `actual_basis_hash`

  哈希值由 pgcrypto 在事务内基于倒置后的真实内容原子计算，保证内容寻址刚性。Worker 返回值为 `won` 或 `demoted`，无需任何重试逻辑。

- **后果**: 竞态窗口在数据库层完全消灭，Worker 对冲突处理过程零感知，主网吞吐量稳如泰山。

---

### ADR 04｜分区策略：Scope 盐化哈希 + LIST 分区 + 双重防御
- **状态**: 已通过 (Approved)
- **上下文**: 长期运行后表体积突破亿级，需要分区优化。但时间分区会强制唯一约束包含时间戳，从而击穿 OCC 乐观锁语义。
- **决策**: 严禁对 `execution_event_log` 使用基于时间范围的声明式分区。强制采用基于 `scope_id` 的列表分区（`PARTITION BY LIST (scope_id)`）。密码学层（ADR 02 盐化哈希）与数据库物理层（`UNIQUE(predecessor_hash, scope_id)`）实现双重硬核防脏写。

  子表结构示例：
  ```sql
  CREATE TABLE execution_event_log_scope_{id}
  PARTITION OF execution_event_log FOR VALUES IN ('{id}');

  ALTER TABLE execution_event_log_scope_{id}
  ADD CONSTRAINT uk_scope_composite_occ_{id} UNIQUE (predecessor_hash, scope_id);

  CREATE INDEX IF NOT EXISTS idx_scope_{id}_vector_hnsw
  ON execution_event_log_scope_{id}
  USING hnsw (embedding vector_cosine_ops);
  ```

- **后果**: 查询复杂度锁死在单分区子表内，跨 Scope 哈希碰撞在数理上被消灭。

---

### ADR 05｜Scope 筑巢协议：三阶段控制面前置 DDL
- **状态**: 已通过 (Approved)
- **上下文**: 动态分区需要 DDL 操作。DDL 持有 `AccessExclusiveLock`，若在业务热路径执行会阻塞所有读写。Worker 不应承担 DDL 权限。
- **决策**: DDL 权限从业务数据面完全剥离，由总线内核专属控制面守护线程独占执行三阶段筑巢协议：

  1. **拦截意图**: 控制面拦截新 Scope 启动意图，生成 scope_id，在内存层挂起所有入网流量
  2. **独占筑巢（DDL）**: 调度物理隔离的独占控制连接池（1-2 个连接），发起单次强事务 DDL：派生子表分区 + 绑定复合唯一锁 + 构建 HNSW 向量索引
  3. **开闸放水（DML）**: DDL Commit 成功回执后，原子注入首个 `plan_created` 事件，业务 Worker 正式唤醒

  **刚性规范**:
  - Worker 数据库账户权限硬限缩为纯 `SELECT/INSERT`，物理上无 DDL 权限
  - 高频长周期任务允许开启预创建缓冲池，低谷期预物化未来 N 个空白分区
  - `CREATE TABLE IF NOT EXISTS` 保证控制面操作幂等

- **后果**: 热路径永远只见 DML，DDL 锁污染从架构层彻底消灭。

---

### ADR 06｜冷热分表归档策略
- **状态**: 已通过 (Approved)
- **上下文**: 热表需要永远维持轻量身段以保证 OCC 性能，但历史数据需要保留。
- **决策**: 热表 `execution_event_log` 永远只维持活跃状态的 Scope 分区，身段控制在百万级。当接收到 `scope_closed` 协同事件时，后台归档进程执行 `ALTER TABLE ... DETACH PARTITION` 卸载，随后批量迁移至无唯一约束的冷表 `archived_event_log`，确保核心热表零物理碎片、零 Vacuum 负担。冷表可单独按时间做声明式分区，不影响热表 OCC。

- **后果**: 系统长期运行后热表始终保持高性能，历史数据完整保留在冷表供审计和反思。

---

### ADR 07｜内存热图生命周期与快照重建
- **状态**: 已通过 (Approved)
- **上下文**: 系统重启或 Worker 冷启动时，内存热图需要从 PostgreSQL 事件日志重建。长期运行后全量重放会引发重放风暴。
- **决策**: 内存热图生命周期与重构边界严格限缩在单 `scope_id` 物理子表内。采用快照+增量重放策略，快照写入时机与 `scope_closed` 事件强对齐。系统冷启动时，直接从快照反序列化骨架，随后顺着 `last_event_id` 流式增量追加，启动速度维持在 O(1)。

- **后果**: 无论历史事件积累多少，冷启动时间恒定可控，不发生重放风暴。

---

## 第二层：控制流层

### ADR 08｜High-Water Mark 持久化水位线
- **状态**: 已通过 (Approved)
- **上下文**: iii-engine 断线重连后，若从头重放所有历史事件，会引发流量风暴把系统打垮。
- **决策**: 事件主键使用 BIGSERIAL 物理序列号作为确定性标尺，由总线在 `bus_state` 表中异步推进已成功广播的 `last_processed_id` 水位标记。总线重连后执行：

  ```sql
  SELECT * FROM events WHERE id > last_processed_event_id ORDER BY id ASC;
  ```

  只补发真正漏掉的事件，无论历史积累多少条都不受影响。

- **后果**: 精准补发，消灭重放风暴，总线断线重连后状态完整恢复。

---

### ADR 09｜LISTEN/NOTIFY Pulse-Fetch Pattern
- **状态**: 已通过 (Approved)
- **上下文**: PostgreSQL NOTIFY 有 8000 字节 payload 硬性上限。Worker 主动通知总线存在双写不一致和并发时序错乱问题。
- **决策**: 将 LISTEN/NOTIFY 定位为轻量级边缘触发信号，而非消息队列。触发器发出的通知 JSON 严格限制在 64 字节以内，仅携带 `{"id": $event_id}`。总线监听到信号后，利用专属只读连接池执行 BIGSERIAL 主键点查（<0.1ms）取完整事件元数据。主路径：AFTER INSERT 触发器 → NOTIFY → 实时广播。保底路径：HWM 断线补发。

- **后果**: 彻底切断 Worker 的主动通知行为，双写不一致问题从架构层消灭。

---

### ADR 10｜订阅关系冷热分离
- **状态**: 已通过 (Approved)
- **上下文**: 广播热路径严禁引入 I/O 阻塞。但订阅关系若只存内存，总线重启后全部丢失。幽灵连接（僵尸订阅）会持续消耗资源。
- **决策**: 热路径：全量 Worker WebSocket 动态订阅拓扑图完全维持在内存 DashMap 中，微秒级分发。冷备份：订阅变更通过时间窗阻尼器以 Write-Behind 异步写沉淀回 PostgreSQL `worker_subscriptions` 冷表。总线重启时读取冷表预物化骨架，心跳 Ping 确认后无损挂载句柄。WebSocket 心跳超时自动驱逐幽灵连接。

- **后果**: 广播热路径零 I/O 阻塞，总线重启后订阅关系完整恢复，幽灵连接被主动清除。

---

### ADR 11｜Worker 幂等与 OCC 合一
- **状态**: 已通过 (Approved)
- **上下文**: 网络采用 at-least-once 交付语义，存在重复消费风险。
- **决策**: 幂等检查与并发 OCC 锁在 Writable CTE 的 `attempt_insert` 阶段合二为一。若事件已被重复消费，由于正统节点和唯一索引已硬性存在，数据库直接拒绝并向应用层安全返回 `Already Processed`，在单次事务边界内优雅阻断。

- **后果**: 重复消费和并发冲突在同一个 CTE 内统一处理，Worker 无需额外幂等逻辑。

---

### ADR 12｜法定认知事件枚举表
- **状态**: 已通过 (Approved)
- **上下文**: 多 Worker 异步操作同一张图时，事件类型不统一会导致去中心化架构散架。
- **决策**: 严格锁定系统五大核心法定认知事件：

  | 事件类型 | 触发场景 | 变更受体 |
  |---|---|---|
  | `plan_created` | 新意图启动，Scope 首个事件 | 触发控制面筑巢，创建 Scope 根节点 N_root |
  | `task_spawned` | 大模型将宏观任务拆解为具体子任务 | 创建待执行任务节点，声明强依赖前驱边 |
  | `memory_updated` | Worker 执行成功写入新事实，或合并收敛 | 产生新 version_hash，向后推进正统版本链 |
  | `conflict_detected` | 并发抢占 OCC 锁失败，触发原子因果倒置 | 强行产生分叉行并落盘，唤醒合并器 |
  | `scope_closed` | 看门狗终审判定当前 Scope 拓扑完美闭环 | 终止 Scope 生命周期，触发冷归档与模板审计 |

- **后果**: 任何不在枚举表内的事件类型被总线拒绝，消灭幻觉驱动的非法事件注入。

---

## 第三层：拓扑视界切片层

### ADR 13｜拓扑视界切片算法（Knapsack Slicing）
- **状态**: 已通过 (Approved)
- **上下文**: 不同模型上下文窗口大小不同。固定 K 代截断在深层链路中会丧失宏观意图感知，全量追溯会撑爆 Context Window。
- **决策**: Worker 被唤醒前由热图计算层动态执行双轴背包切片算法：

  ```
  输入：N_current, W_max

  第一步：纵轴 S_lineage
    predecessor_hash 逆向追溯至 event_type='plan_created' 的 N_root
    → 完整因果骨架（刚性边界）

  第二步：横轴 S_siblings
    同 scope_id 内扫描兄弟节点
    仅保留 status ∈ {pending, conflict_detected, 最新 memory_updated}

  第三步：Knapsack Slicing
    W_core = Size(N_root) + Size(N_current) + Size(S_siblings)

    if W_core > W_max:
        宽度熔断 → 仅注入 N_root + N_current
    else:
        锁定注入 N_root + N_current + S_siblings
        ΔW = W_max - W_core
        S_lineage 中间祖先按时序倒序（新→老）逐个填入直到 ΔW 耗尽
  ```

- **后果**: Worker 既能一眼看到最初用户意图（N_root），又能精准看到直接前驱，还能横向瞥见并行兄弟任务状态。Context Window 永远压在安全线以下。

---

### ADR 14｜Context Window 安全容量公式
- **状态**: 已通过 (Approved)
- **上下文**: 不同模型物理窗口尺寸不同，System Prompt 和 △_padding 占用必须提前扣除，否则会发生 Context OOM。
- **决策**: 任何 Worker 调用大模型前，必须通过以下刚性公式计算安全上限：

  ```
  W_max = W_physical - W_system_prompt - △_padding
  ```

  严禁产生裸调用，从数学源头强制扣除刚性系统开销与运行期的自适应弹性防震垫片。

- **后果**: Context OOM 的物理概率从架构层降归为零。

---

## 第四层：Token 计算层

### ADR 15｜Wasm Tokenizer 旁路预检
- **状态**: 已通过 (Approved)
- **上下文**: 不同厂商不同代际模型的 Tokenizer 碎片化严重。私有化托管 API Gateway 存在隐藏 Prompt 模板差异，本地 tiktoken 无法 100% 精确预测。
- **决策**: 总线核心保持轻量无状态。由连接网关层挂载高性能纯 Rust 实现的 WebAssembly 旁路分词插件（支持 `cl100k_base`、`o200k_base`、`llama3` 等多厂商模型指纹），在 <1ms 内计算精确 Token 数，作为原生烙印写入 `payload._meta.tokens[model_fingerprint]`，作为 Knapsack 算法的绝对数理依据。

- **后果**: 总线不需要为每个模型集成厚重编解码库，高吞吐性能不受影响，Token 计算精度工业级保障。

---

### ADR 16｜△_padding 动态自适应垫片
- **状态**: 已通过 (Approved)
- **上下文**: 黑盒 Prompt、隐藏占位符、多语言转换会导致实际 Token 消耗超过预估。静态安全边际无法自适应不同 Worker 的实际偏差。
- **决策**: 设定初始值 4096 tokens 的弹性安全缓冲垫片。冷热分离：内存热值 + 每 5 秒时间窗阻尼器异步 Upsert PostgreSQL `worker_profiles` 表。总线常驻网关强行拦截模型响应的真实 `usage.prompt_tokens`，一旦发生估算漏损，以 1.5 倍惩罚性加权迅速撑大：

  ```
  △_padding_new = △_padding + (实际 prompt_tokens - 估算 tokens) × 1.5
  ```

  每个 Worker 通道维护独立垫片，互不干扰。

- **后果**: 在 1-2 次交互内自适应闭环，Context OOM 物理概率降归为零。

---

## 第五层：Vector 检索层

### ADR 17｜pgvector 原子写入与强制预过滤规范
- **状态**: 已通过 (Approved)
- **上下文**: 独立向量数据库（如 Qdrant）的向量写入与事件写入是两个独立操作，存在双写窗口，破坏 SSOT 原则。pgvector 无法将过滤器下推到向量索引扫描层。
- **决策**: 高维语义向量（`embedding vector(1536)`）作为主表原生字段，在单次 Writable CTE 事务内同生共死原子落盘。每个 Scope 子表在筑巢阶段（ADR 05）同步创建 HNSW 索引。

  发散性反思轨道强制查询军规（禁止全表向量检索）：
  ```sql
  WITH candidates AS (
    SELECT entity_id, version_hash, event_type, payload, embedding
    FROM execution_event_log
    WHERE scope_id = $scope_id
      AND event_type != 'conflict_detected'
  )
  SELECT entity_id, version_hash, payload,
         embedding <=> $query_embedding AS distance
  FROM candidates
  ORDER BY distance
  LIMIT 10;
  ```

  **注记（2026-05-31）**：上述 CTE 模式是全候选集精确扫描，不走 HNSW 索引，适合中小规模 scope（< 10,000 行）。pgvector 0.8.0 引入 `hnsw.iterative_scan = strict_order`，可在大规模 scope 场景获得更好的 filtered ANN 性能，作为 Phase 3 优化项。pgvector 的过滤器在索引扫描后执行（不下推），0.8.0 前后均如此，iterative_scan 仅改善召回率而非改变过滤时机。

- **后果**: 向量与事件的 SSOT 原则不破坏，pgvector 过滤性能陷阱被规范层消灭。

---

## 第六层：合成与收敛层

### ADR 18｜收敛节点写回协议（Convergence Write-back Protocol）
- **状态**: 已通过 (Approved)
- **上下文**: 处理冲突合并（热路径）与处理模板提案（冷路径）职责完全不同，必须物理隔离。v_merged 的 predecessor_hash 指向错误会导致图环路死锁或历史断裂。
- **决策**: ConflictResolverWorker 与 TemplateProposalWorker 在物理、部署、Context Window 上完全独立解耦。

  收敛节点 v_merged 写回规范：
  - `event_type` 刚性标记为 `memory_updated`，重归正统版本链
  - `predecessor_hash` 必须刚性指向分叉末端行 v_2（conflict_detected 节点），不得越过任何历史节点
  - Payload 必须强制内嵌 `convergence_gate` 双向锚定矩阵：

  ```json
  {
    "event_type": "memory_updated",
    "payload": {
      "business_fact": "...",
      "_meta": {
        "tokens": { "model_x": 120 },
        "convergence_gate": {
          "legitimate_basis_hash": "H_v1",
          "conflicted_basis_hash": "H_v2",
          "clash_scope_root_hash": "H_basis"
        }
      }
    }
  }
  ```

  **附加规范**:
  - 总线连接层强行校验 predecessor_hash 不得逆向越过冲突行，违者直接拒绝提交
  - convergence_gate 落盘成功后，总线立即解除对当前 Scope 被挂起兄弟节点的流控阻断

- **后果**: 物理线性的完美继承，彻底消灭拓扑震荡，账本绝对神圣不可变性得到保障。

---

### ADR 19｜拓扑收敛看门狗（Topology Convergence Watchdog）
- **状态**: 已通过 (Approved)
- **上下文**: `scope_closed` 是触发冷归档与模板审计的最高开关，传统超时判定或单纯内存计数极易误触发。
- **决策**: 确立控制面专职状态机组件——拓扑收敛看门狗——为 `scope_closed` 的全局唯一判定主体，内嵌在 iii-engine Pulse-Fetch 控制路径中。三级刚性防御：

  **第一级：内存双轨原子计数**
  ```rust
  struct ScopeConvergenceTracker {
      total_spawned_tasks: AtomicU32,
      completed_tasks: AtomicU32,
  }
  ```
  - `task_spawned` 落盘 → `total_spawned_tasks++`
  - `memory_updated` 且 task status=completed → `completed_tasks++`

  **第二级：冲突拓扑锁拦截**
  - `conflict_detected` 落盘 → 挂起拓扑锁
  - 即便计数器相等，拓扑锁未解除则判定绝对不通过
  - `convergence_gate` 检测到 → 解除拓扑锁

  **第三级：数据库 B-Tree 强一致性终审**
  ```sql
  SELECT COUNT(*)
  FROM execution_event_log_scope_{id} AS e
  WHERE (e.event_type = 'task_spawned' AND e.payload->>'status' != 'completed')
     OR (e.event_type = 'conflict_detected' AND NOT EXISTS (
         SELECT 1
         FROM execution_event_log_scope_{id} AS m
         WHERE m.event_type = 'memory_updated'
           AND m.payload->'_meta'->'convergence_gate'->>'conflicted_basis_hash'
               = e.version_hash
     ));
  ```
  COUNT = 0 → 投递 `scope_closed`；COUNT > 0 → 拒绝，内存状态对齐自愈。

  **⚠️ SQL 修正（2026-05-31）**：原版使用 `NOT IN` 子查询，当子查询结果集含 NULL（绝大多数 `memory_updated` 行不含 `convergence_gate`，路径表达式返回 NULL）时，`NOT IN` 整体为 NULL 而非 TRUE，导致 COUNT 错误归零、看门狗误判收敛。修正为 `NOT EXISTS`，对空集返回 TRUE，含 NULL 行不受影响，行为确定性恢复。

  **附加规范**:
  - 看门狗是系统内唯一有权产生 `scope_closed` 事件的合法源头
  - 任何 Worker 私自投递 `scope_closed` 视为非法路由，直接断开 WebSocket 连接
  - 终审 SQL 执行至 `scope_closed` 落盘期间，当前 Scope 进入原子静默期
  - **控制面直写例外（ADR 13 补充，2026-05-31）**：`context_oom_throttled` 是基础设施级事件，由控制面在 Context OOM 三级熔断时直接写入分区子表，不经过总线事件类型枚举校验，不加入五大法定认知事件枚举。看门狗检测到未解除的 `context_oom_throttled` 时阻断 `scope_closed` 判定，直至控制面写入解除事件。完整规范见 `docs/adr/0024-adr13-supplement-context-oom-degradation.md`。

- **后果**: 零幻觉、零误判，关闭判定降维成纯粹的确定性图拓扑数学题。

---

## 第七层：记忆层

### ADR 20｜四层记忆物理架构（完全自建，PostgreSQL SSOT）
- **状态**: 已通过 (Approved)
- **上下文**: 外部记忆系统（如 agentmemory）使用 SQLite 存储，与我们的 PostgreSQL Execution Graph 物理隔离，无法原子写入，破坏 SSOT 原则。且外部系统不理解 scope_id 盐化哈希模型和 predecessor_hash 版本链。
- **决策**: 完全自建四层记忆，全部统一在 PostgreSQL 内，SSOT 原则不妥协。

  **Working Memory = `execution_event_log` 主表（零额外建表）**
  最原始、最精确的工作记忆，与执行图完全融合。

  **Episodic Memory = `episodic_memory` 表**
  ```sql
  CREATE TABLE episodic_memory (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scope_id        VARCHAR(50) NOT NULL,
      intent_summary  TEXT NOT NULL,
      outcome_summary TEXT NOT NULL,
      embedding       vector(1536),
      key_entities    JSONB,
      error_patterns  JSONB,
      duration_ms     BIGINT NOT NULL,
      task_count      INT NOT NULL,
      conflict_count  INT NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT uk_episodic_scope UNIQUE(scope_id)
  );
  CREATE INDEX idx_episodic_vector_hnsw ON episodic_memory
  USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
  CREATE INDEX idx_episodic_created_at ON episodic_memory (created_at DESC);
  ```

  **Semantic Memory = `semantic_memory` 表**
  ```sql
  CREATE TABLE semantic_memory (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      fact_text           TEXT NOT NULL,
      embedding           vector(1536),
      confidence          FLOAT NOT NULL
          CONSTRAINT ck_semantic_confidence CHECK (confidence >= 0.0 AND confidence <= 1.0),
      reinforcement_count INT NOT NULL DEFAULT 1,
      source_scope_ids    JSONB NOT NULL,
      domain_tags         JSONB,
      superseded_by       UUID,
      created_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_semantic_knowledge_evolution
          FOREIGN KEY (superseded_by) REFERENCES semantic_memory(id) ON DELETE RESTRICT
  );
  CREATE INDEX idx_semantic_active_vector_hnsw ON semantic_memory
  USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)
  WHERE superseded_by IS NULL;
  CREATE INDEX idx_semantic_confidence_active ON semantic_memory (confidence DESC)
  WHERE superseded_by IS NULL;
  ```

  **Procedural Memory = `procedural_memory` 表**
  ```sql
  CREATE TABLE procedural_memory (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      intent_embedding    vector(1536) NOT NULL,
      intent_description  TEXT NOT NULL,
      template_graph      JSONB NOT NULL,
      is_anti_pattern     BOOLEAN NOT NULL DEFAULT FALSE,
      avg_conflict_count  FLOAT NOT NULL DEFAULT 0,
      avg_duration_ms     BIGINT NOT NULL DEFAULT 0,
      success_count       INT NOT NULL DEFAULT 1,
      failure_count       INT NOT NULL DEFAULT 0,
      unique_worker_types INT NOT NULL DEFAULT 1,  -- TemplateProposalWorker 提炼时统计，用于多样性信号
      source_scope_ids    JSONB NOT NULL,
      created_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      last_used_at        TIMESTAMPTZ,
      CONSTRAINT ck_procedural_quality
          CHECK (success_count >= 0 AND failure_count >= 0 AND unique_worker_types >= 1)
  );
  CREATE INDEX idx_procedural_intent_hnsw ON procedural_memory
  USING hnsw (intent_embedding vector_cosine_ops) WITH (m=16, ef_construction=64)
  WHERE is_anti_pattern = FALSE;
  CREATE INDEX idx_procedural_antipattern_hnsw ON procedural_memory
  USING hnsw (intent_embedding vector_cosine_ops) WITH (m=16, ef_construction=64)
  WHERE is_anti_pattern = TRUE;
  ```

  **冷启动匹配查询规范（两阶段 Top-20 ANN + 三信号混合重排）**:
  ```sql
  WITH candidates AS (
      SELECT id, intent_description, template_graph,
             success_count, failure_count, last_used_at,
             (intent_embedding <=> $new_intent_embedding) AS distance
      FROM procedural_memory
      WHERE is_anti_pattern = FALSE
      ORDER BY intent_embedding <=> $new_intent_embedding
      LIMIT 20
  ),
  scored AS (
      SELECT *,
          ((success_count::FLOAT + 1.0) /
           (success_count + failure_count + 1.0)) AS quality_score,
          GREATEST(0.0, 1.0 - (
              EXTRACT(EPOCH FROM (NOW() - COALESCE(last_used_at, NOW()))) / (86400.0 * 30)
          )) AS recency_score,
          (unique_worker_types::FLOAT /
           NULLIF(MAX(unique_worker_types) OVER (), 0)) AS diversity_score
      FROM candidates
  )
  SELECT id, intent_description, template_graph,
         ((1.0 - distance / 2.0) * 0.5 +
          quality_score       * 0.25 +
          recency_score       * 0.1  +
          diversity_score     * 0.15) AS final_score
  FROM scored
  ORDER BY final_score DESC
  LIMIT 3;
  ```

  权重：相似度×0.5 + 质量×0.25 + 时效×0.1 + 多样性×0.15，30 天 Ebbinghaus 衰减周期。
  `diversity_score` 通过窗口函数 `MAX() OVER ()` 归一化至 [0,1]，`unique_worker_types` 由 TemplateProposalWorker 在提炼时统计写入。

  **TemplateProposalWorker 提取漏斗前置过滤（2026-05-31）**：
  进入正样本提炼前强制过滤：`task_count >= 5 AND unique_worker_types >= 2`，彻底排除琐碎低价值任务拓扑，无需人工标注业务权重。

  **注记（2026-05-31，经 pgvector 官方文档验证）**：
  - `m=16, ef_construction=64` 是 pgvector HNSW 的内置默认值，与不写 WITH 子句行为相同，参数选择正确。
  - 查询时默认 `hnsw.ef_search=40`。当过滤后候选集较小（< 100 条）时，建议 `SET hnsw.ef_search = 100` 提升召回率。
  - 上述查询为单路向量 + 四信号线性加权（无 BM25）。加入 BM25 后须改用双路 RRF（见 P0-A/P0-B 研究），结构变为：RRF(vector_rank, bm25_rank) × 0.5 + quality × 0.25 + recency × 0.1 + diversity × 0.15。
  - `last_used_at` 初始为 NULL 时，recency_score 公式 `1.0 - EXTRACT(EPOCH FROM (NOW() - last_used_at)) / (86400.0 * 30)` 会产生 NULL，需在查询中用 `COALESCE(last_used_at, created_at)` 保护。

- **后果**: 四层记忆全部统一在 PostgreSQL 内，SSOT 原则不破坏，向量写入与事件写入原子同生共死，记忆系统具备完整的版本链、强化衰减、矛盾检测能力。

---

### ADR 21｜发散性反思轨道触发规范（mem::reflect 接口与 Token 预算）
- **状态**: 已通过 (Approved)
- **上下文**: RFC §4.4 定义了发散性反思轨道的三个触发场景（`conflict_detected`、`macro_planning`、`cold_start`）和总预算公式，但触发接口设计、Context Window 注入结构、三层记忆截断算法及触发类型差异化预算均未被任何 ADR 覆盖。
- **决策**:
  1. **集中式 `mem::reflect` 函数**：在 iii-engine 层实现，Worker 通过单一 iii Function 触发，传入 `{query_text, query_embedding, trigger_type, w_max, scope_id}`，接收格式化的 `[REFLECTION MEMORY]` 注入内容。符合 ADR 05 权限隔离（Worker 无需直接查询三表 schema）。
  2. **注入结构**：`[REFLECTION MEMORY]` 作为独立分区，位于 `[EXECUTION CONTEXT]` 之后，内含 Procedural / Episodic / Semantic 三个子分区。
  3. **顺序贪心截断**：Procedural 先取（LIMIT 1–3，超过 B×0.6 时仅注入摘要，跳过完整 JSON），剩余预算给 Episodic（LIMIT 5），再剩给 Semantic（LIMIT 5）。Wasm Tokenizer（ADR 15）实时计算各层消耗。
  4. **触发类型差异化预算**：`cold_start`/`macro_planning` 上限 `min(2000, W_max×0.3)`，Procedural LIMIT=3；`conflict_detected` 上限降为 `min(1000, W_max×0.2)`，Procedural LIMIT=1。
- **后果**: Worker 无需了解记忆表 schema，RRF 融合逻辑和 Token 预算截断全部封装在 iii-engine 层；反思轨道的可观测性（token 消耗）通过 iii-observability 统一监控；触发类型预算差异化为可调参数，Phase 1 固定初值，后续基于实测调整。完整规范见 `docs/adr/0022-adr21-reflection-track-trigger-spec.md`。

---

## ADR 目录索引

```
跨切面层
  ADR 22｜LLM/Embedding Provider 抽象层与最小化原则

第一层：基础存储层
  ADR 01｜核心系统原语：执行图与 PostgreSQL append-only 事件日志
  ADR 02｜实体同一性与 Scope 盐化内容寻址模型
  ADR 03｜乐观并发控制：Writable CTE 原子因果倒置
  ADR 04｜分区策略：Scope 盐化哈希 + LIST 分区 + 双重防御
  ADR 05｜Scope 筑巢协议：三阶段控制面前置 DDL
  ADR 06｜冷热分表归档策略
  ADR 07｜内存热图生命周期与快照重建

第二层：控制流层
  ADR 08｜High-Water Mark 持久化水位线
  ADR 09｜LISTEN/NOTIFY Pulse-Fetch Pattern
  ADR 10｜订阅关系冷热分离
  ADR 11｜Worker 幂等与 OCC 合一
  ADR 12｜法定认知事件枚举表

第三层：拓扑视界切片层
  ADR 13｜拓扑视界切片算法（Knapsack Slicing）
  ADR 14｜Context Window 安全容量公式

第四层：Token 计算层
  ADR 15｜Wasm Tokenizer 旁路预检
  ADR 16｜△_padding 动态自适应垫片

第五层：Vector 检索层
  ADR 17｜pgvector 原子写入与强制预过滤规范

第六层：合成与收敛层
  ADR 18｜收敛节点写回协议（Convergence Write-back Protocol）
  ADR 19｜拓扑收敛看门狗（Topology Convergence Watchdog）

第七层：记忆层
  ADR 20｜四层记忆物理架构（完全自建，PostgreSQL SSOT）
  ADR 21｜发散性反思轨道触发规范（mem::reflect 接口与 Token 预算）
```

### ADR 22｜LLM/Embedding Provider 抽象层与最小化原则
- **状态**: 已通过 (Approved)
- **上下文**: 系统多处不可避免地调用推理模型（Worker 推理、冲突合并、模板提炼）和嵌入模型（`mem::reflect`、记忆写入向量化）。若硬编码具体 API，系统无法在离线或受限环境运行。
- **决策**: 建立两条原则：① **最小化 LLM 调用**——凡能用确定性算法完成的功能禁止用 LLM；每处不可避免的调用须在 ADR 中显式标注。② **Provider 抽象接口**——在 iii-engine 层统一 `LLMProvider` / `EmbeddingProvider` 接口，Phase 1 实现 OpenAI-compatible 一种 Provider（覆盖 ollama、llama.cpp、lmstudio、OpenAI 等所有兼容端点），后续按需适配 Anthropic 等。Worker 不持有 Provider 凭证，凭证统一在 iii-config.yaml 管理。Embedding 调用消耗不计入 Worker △_padding，写入 iii-observability 单独监控。
- **后果**: 系统可在纯本地环境（无网络）运行；LLM 调用点全部有显式文档记录；新增 Provider 只需实现两个接口，Worker 代码不变。

---

**ADR 13 补充｜拓扑视界宽度熔断三级降级链路**（`docs/adr/0024-adr13-supplement-context-oom-degradation.md`）
- 三级自适应降级：N_root 蒸馏（⚠️ LLM）→ N_current 尾流截断 → 控制面直写 `context_oom_throttled`，Scope 进入 Suspended

**ADR 23｜嵌套 Scope 与子 Scope 关闭传导协议**（`docs/adr/0025-adr23-nested-scope-propagation.md`）
- Phase 1 前向兼容预埋（`spawn_sub_scope: true` 静默忽略），Phase 3 激活完整机制
- `scope_lineage` 元数据冷表 + 三步火炬传递：子 `scope_closed` → 控制面直写 `sub_scope_resolved` → SubScopeResultWorker 语义合并 → 父 `memory_updated`
- 控制面保持纯基础设施角色，业务语义合成在 Worker 层（ADR 12 五大枚举不变）

**共 23 条 ADR（含 2 条补充），七层架构全部覆盖。**
