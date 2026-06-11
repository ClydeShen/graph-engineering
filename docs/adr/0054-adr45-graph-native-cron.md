# ADR 45｜Graph-native Cron：定时任务即图上 Entity

status: accepted
日期: 2026-06-11

---

## 上下文

hermes 的 cron 把 job 存 `jobs.json`、运行历史存独立目录——定时执行与手动执行是两套记录系统。Memex 的范式回答（Phase 12）：**定时任务是图上的 Entity，每次触发是一条普通 Trail**——定时 turn 与手动 turn 用同一套记录，Trail Discovery 可以学习"这个周报任务每次都在同一步骤偏离"（09-DESIGN-NOTES 交叉引用第 3 条）。

## 决策

### D-1：Cron Job = Entity Snapshot（append-only 配置史）

job 定义存于一个专属 Scope（`cron:registry`）内的 Entity，payload：

```json
{
  "kind": "cron_job",
  "name": "weekly-report",
  "schedule": "0 9 * * 1",
  "prompt": "生成本周工作摘要",
  "deliver": "origin",
  "origin": "telegram:12345678",
  "enabled": true
}
```

- **修改 = 新 Snapshot**（同 entity_id 链上追加 `memory_updated`）——配置变更历史天然保留、可审计；当前定义 = 该 entity 链的 tip
- 删除 = `enabled: false` 的新 Snapshot（append-only，不物理删）
- schedule 用标准 5 字段 cron 表达式（job 语义层）；与 iii-cron 的 7 字段（引擎调度层）无关

### D-2：触发语义——每 tick 新 Scope

- CronWorker 由 iii-cron 每分钟触发（`0 * * * * * *` 7 字段）
- tick 流程：读 `cron:registry` Scope 全部 cron_job entity tips → 对每个 enabled job 做 due 判定 → due 则 `nestScope("cron:<name>:<ISO时间>")` + 写入 `task_spawned`（payload 含 prompt、deliver、origin、`required_skills: ['message-handler']`）
- **每次运行一条独立 Trail**——与 Telegram 消息产生的 Scope 结构同形

### D-3：错过的 tick 不补跑

宕机期间错过的触发**不补跑**：恢复后下一个匹配时刻正常触发，且对每个检测到的错过周期写一条 `memex::cron::missed` 记录（cron registry Scope 内，memory_updated 事件 payload 标记）——可审计、不堆积。补跑语义（catch-up）是显式不做的复杂度：周报补发三份没有意义。

### D-4：due 判定与精度

- 精度承诺：**分钟级**。due 判定 = `cronMatches(schedule, now)` 且本分钟未触发过（`last_fired_at` 存 job entity 的新 Snapshot？否——见下）
- 触发去重：CronWorker 在 tick 内维护 job→分钟 的判定，跨进程重启的去重靠 `nestScope` intent 含分钟时间戳——同一分钟重复 tick 产生同 intent 的 scope 创建，由 advisory/唯一性兜底（intent 查重：创建前查 `scope_lineage WHERE intent = $1`，存在即跳过）。**不为去重写回 job entity**（避免每分钟产生 Snapshot 噪音）

### D-5：投递

运行 Scope 关闭后，结果经 DeliveryRouter 按 job 的 `deliver` 字段投递（`origin` / `<platform>` / `<platform>:<chat_id>` / `all` / 逗号组合）。静默标记（输出以 `[SILENT]` 开头）不投递。

## 后果

- cron 配置史、运行史全在图中——零新存储系统，Trail Discovery 直接消费
- 不补跑 + 分钟级精度是显式声明的边界（SECURITY.md/文档如实写）
- registry Scope 是常驻 Scope（永不收敛关闭）——watchdog 需将 `cron:registry` intent 排除在收敛判定外？不需要：registry Scope 只有 memory_updated 事件（无 pending task），收敛判定 `pending=0` 恒真但 conflicts=0 也真——会被自动关闭！**对策：registry Scope 的 job 写入用 status='archived' 直写**……过度复杂。**简化：job 定义不存图 Scope，存 `cron_job` 专表？** 违背"配置即图"。再想：writeScopeClosed 仅在 POST events 路径触发（processAgentTurn inline watchdog）；CronWorker 直接用 occWrite 写 registry Scope，不走 Gateway events 路由 → inline watchdog 不会跑 → registry Scope 不会被自动关闭。Control-plane watchdog 扫描的是含 pending task 的 Scope。**结论：CronWorker 直写（occWrite）registry Scope，规避 Gateway 收敛路径**——记录为实现约束。

## 关联

ADR 24（入口协议——cron 运行 Scope 与消息 Scope 同形）；ADR 41（OCC）；Phase 12 DeliveryRouter；09-DESIGN-NOTES（定时 turn 与手动 turn 同记录系统）。
