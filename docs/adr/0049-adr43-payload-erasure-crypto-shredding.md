# ADR 43｜不可变账本下的数据删除权：crypto-shredding 与派生数据级联

status: accepted
日期: 2026-06-11

---

## 上下文

Trail Mesh 是 append-only 不可变账本：版本哈希按 `{scope_id}|{entity_id}|{predecessor_hash}|{event_type}|{canonical_json(payload)}` 计算，前驱哈希形成不可篡改的因果链。这与"数据删除权"（GDPR 式诉求、用户要求删除某段敏感对话）直接冲突——物理删除任何节点的 payload 都会使该节点的内容哈希无法重验。

此问题**现在**必须决策（而非 Phase 14 安全硬化时），原因是 Phase 09 即将创建三张记忆表（episodic / semantic / procedural）：

1. 记忆行是从 Trail payload **蒸馏的派生数据**——删除源数据时若无法定位派生行，删除权形同虚设
2. embedding 向量可逆推原文语义，属派生 PII，必须随源数据一起删除
3. 表结构落地后再补 provenance 列，迁移成本远高于建表时就带上

业界对不可变存储的删除权有成熟答案：**crypto-shredding**（内容加密存储，销毁密钥即逻辑删除）与 **payload 外置**（账本只存哈希承诺，内容存可删除的旁路存储）。两者共同点：**因果结构与内容分离——结构永久，内容可消失**。

---

## 决策

### D-1：删除单元是 payload 内容，因果结构永不删除

erase 操作只使 payload **内容**不可恢复。以下永久保留：

- `scope_id`、`entity_id`、`event_type`、时间戳
- `version_hash`、`predecessor_hash`（存储值，链路结构完整）
- Association 的拓扑（谁连接谁）

被删节点的图结构仍可参与因果追溯和拓扑分析——只是"说了什么"消失，"发生过什么形状的事"保留。这与 Memex 哲学一致：Trail 的拓扑价值独立于内容。

### D-2：机制方向——per-Scope DEK 信封加密，分两步落地

- **密钥模型**：每个 Scope 一把 DEK（data encryption key）；DEK 由 KEK 包裹存入 `key_registry` 表。删除请求的自然粒度是"这段对话/这个任务"，与 Scope 边界吻合。
- **erase(scope) = 销毁该 Scope 的 DEK**（从 `key_registry` 删除包裹后的 DEK），密文永久不可解。
- **落地分两步**：
  - **Phase 09（现在）**：只做 schema 预留——记忆表带 provenance 列（D-4），账本 payload 维持现状明文 JSONB，不引入加密。
  - **Phase 14（信任硬化）**：实现 payload 加密存储（payload vault 或列级密文，届时定）、`key_registry`、erase 工作流。

> 依据"值变更 vs 类型变更"原则：加密存储是 Phase 14 可独立实施的实现细节（不触碰 Phase 09 的表）；provenance 列是必须现在定的类型级决策。

### D-3：哈希验证语义——erased 节点显式跳过内容重验，链路验证保留

- 版本哈希计算规格**不变**（仍按 canonical_json(payload) 明文计算）——不为删除权改变全系统哈希语义。
- 节点增加 `erased_at TIMESTAMPTZ NULL`（账本表 Phase 14 迁移时加；记忆表 Phase 09 建表即带）。
- 验证器规则：`erased_at IS NOT NULL` 的节点**跳过内容哈希重验**（无 payload 可验），但 predecessor 链接验证照常——这是显式的"已删除"状态，不是验证失败。
- `version_hash` 保留为内容承诺（commitment）：若日后有人声称"被删内容是 X"，仍可单点验证。

### D-4：派生数据级联——Phase 09 记忆表必须带 provenance（本 ADR 唯一阻塞 Phase 09 的决策）

三张记忆表（episodic / semantic / procedural）每行必须携带：

```sql
source_scope_id  UUID NOT NULL,        -- 蒸馏来源 Scope
erased_at        TIMESTAMPTZ NULL      -- 级联删除标记
```

（多源行用 `source_scope_ids UUID[]`，见下文 Lesson 规则。）

**erase(scope) 级联语义**：

| 派生数据 | 处理 |
|---|---|
| episodic 行（单源） | 物理删除行 + embedding |
| semantic / procedural 行（单源） | 物理删除行 + embedding |
| 多源 Lesson（fingerprint 聚合自多个 Scope） | 从 `source_scope_ids` 移除该 scope + 标记 `needs_redistill`，下次 reinforcement 时由 CrystallizeWorker 基于剩余源重蒸馏 |
| embedding 向量 | 一律随行删除——向量可逆推内容，按 PII 对待 |

派生行是检索投影、不是账本，物理删除不违反 append-only 哲学（账本结构由 D-1 保护）。

### D-5：erase 操作本身入图

删除请求写入 `memex::payload::erase` 事件（payload 只含 scope_id、请求方 principal、原因枚举——**不含被删内容**）。删除有完整审计轨迹，但审计不泄露内容。这与 Phase 14"安全事件入图"一致。

### D-6：与 PII 脱敏的分工

- **Redaction（Phase 14）**：写入前防御——发送给 LLM / 写入账本前脱敏已知 PII 模式。
- **Erasure（本 ADR）**：事后救济——已写入的内容应请求而消失。

两者互补，不互替。

---

## 后果

**得到：**
- Phase 09 建表即满足删除权的结构前提，无返工
- append-only 哲学保留——结构不可变，内容可消失，哈希规格不变
- 删除可审计、可级联、粒度与用户心智模型（"删掉那次对话"）一致

**代价与已知边界：**
- erased Scope 退出 Trail Discovery 语料（拓扑仍在，内容缺失）——统计影响可接受，删除本就该有代价
- **备份边界**：crypto-shredding 触及不到已落盘的旧备份。Phase 15 备份设计必须遵守：备份加密所用密钥体系与 `key_registry` 同源，使"销毁 DEK"对备份同样生效；否则需文档化"备份保留期 = 删除生效延迟"
- 多源 Lesson 的 `needs_redistill` 在下次 reinforcement 前存在"内容已删、Lesson 暂存旧蒸馏"的窗口期——可接受（Lesson 是抽象洞察，非原文），但需在 SECURITY.md（Phase 16）中如实声明

**关联：** ADR-13（Knapsack——erased 节点零 token 参与装包）；ADR-20（混合检索——删除需同步清理 GIN/HNSW 索引行）；Phase 14 信任硬化（加密落地）；Phase 15（备份语义）；Phase 16（SECURITY.md 声明）。
