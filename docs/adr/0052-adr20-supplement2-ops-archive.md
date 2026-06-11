# ADR 20 Supplement 2｜强化/归纳/衰减操作规范归档（TD-D：P1-D / P2-D / P2-E）

status: accepted
日期: 2026-06-11
supplements: ADR 20（四层记忆物理架构）；ADR 20 Supplement（0021，混合检索）

---

本文档归档三项"内容已明确、待补文档"的操作规范（追踪表 P1-D / P2-D / P2-E），随 Phase 10 实现一并入档。Ebbinghaus 闭环的三条时间线**职责分离**，不混入同一 worker 路径：

## 1. 强化（P1-D）——事件驱动

```sql
UPDATE procedural_memory
SET success_count = success_count + 1, last_used_at = NOW()
WHERE id = $matched_template_id;
```

**调用方（Phase 10 闭合）**：`TemplateProposalWorker.onScopeClosed` Step 6——Scope 收敛关闭时，对 `template_injection` 表中该 Scope 的全部注入模板执行强化。采纳判定 = Scope 收敛关闭（`scope_closed` 仅在 `isConverged AND noOpenConflicts` 时写入，watchdog Tier-3）；注入未采纳（Scope 挂起/超时）则只有 `injection_count`，无 `success_count`——这本身是负信号。

**命中率查询（Phase 16 eval 数据通路）**：

```sql
SELECT COALESCE(SUM(success_count)::FLOAT / NULLIF(SUM(injection_count), 0), 0) AS hit_rate
FROM procedural_memory WHERE is_anti_pattern = FALSE;
```

## 2. 归纳（P2-D）——cron 主触发

- **主触发**：每日 02:00（`SYNTHESIZER_CRON_TRIGGER`，iii-cron 7 字段 `0 0 2 * * * *`）；扫描近 25 小时活跃 Scope（LIMIT 10），episodic → LLM 蒸馏 → procedural。
- **可选事件触发（≥20 条 episodic 即时归纳）**：**不实现**——cron 主触发已覆盖时效需求，事件触发增加一条 LLM 调用路径而无实证收益（YAGNI）。若日批延迟成为实测痛点再启用。

## 3. 衰减（P2-E）——cron

- 每日 03:00（`DECAY_CRON_TRIGGER`，错开归纳）：`reinforcement_count = 0 AND last_used_at < NOW() - INTERVAL '90 days'` → `superseded_by = id`（逻辑删除，append-only 原则，不物理 DELETE）。
- 04:00 `TTL_CRON_TRIGGER`：working_memory 24h TTL 物理清理（检索投影非账本，物理删除合规——同 ADR-43 D-4 派生数据论证）。

## 实现索引

`packages/workers/src/memory/synthesizer.worker.ts`（三 cron 常量 + runDecay/runTtlPurge）；`memory-repository.ts`（`reinforceTemplate` / `markSupersededByEbbinghaus` / `purgeTTLWorkingMemory`）；`template-proposal.worker.ts` Step 6（强化调用方）；migration 013（injection 关联表）。
