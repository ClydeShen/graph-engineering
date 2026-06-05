# graph-enginerring memory

## 项目状态
- [设计验证](project_graph-enginerring-design-verification.md) — 23 ADRs 锁定，ADR 02 jsonb::text REFUTED，tokio-postgres poll_message，P0-A/B/C 全解
- [范式定位](project_graph-enginerring-paradigm-shift.md) — 核心身份：workflow discovery，非 graph runtime；4 范式规则锁定；no workflow layer

## Phase 1 grill 经验
- [Plan B queue adapter grill](lesson/2026-05-28-plan-b-queue-adapter-fixes.md) — PgQueueAdapter 结构性修复 7 项
- [Plan C graph topology grill](lesson/2026-05-28-plan-c-graph-topology-fixes.md) — graph topology forgetting 结构性修复 8 项

## Phase 1 实现偏差教训
- [语义列值完整性](lesson/2026-06-03-semantic-column-integrity.md) — 存储层物理列值必须忠实承载语义，禁止用 payload 字段替代一等公民列值（"因果降维泄露"）
- [状态维度分离](lesson/2026-06-03-state-dimension-separation.md) — 状态值设计前先问"哪几个维度"，维度不同则状态值必须分开，单值多维是状态机崩溃前兆
- [防护层纵深](lesson/2026-06-03-defense-in-depth.md) — 安全关键路径：类型约束（编译期）+ RuntimeException + HTTP 入口拒绝策略，三层缺一不可
- [技术债时机](lesson/2026-06-03-technical-debt-timing.md) — 区分"现在爆炸的 bug"（立即修）和"触发点风险"（识别精确触发点，定点还清）

## Phase 2 状态
- [Gate 2 交付完毕](project_phase2-gate2-delivered.md) — health/topology routes、write-guard、P0-E fix 已 push；Phase 2 planning 是下一步（issue #17）

## OCC 架构决策
- [OCC 因果追加](lesson/2026-06-04-occ-causal-append.md) — ADR 41：losers 插新行，winner 行永不变更；OCC_WRITE_SQL 现为接受 partition 的函数

## 架构扩展设计
- [Plugin/Registry scope](feedback_plugin-registry-scope.md) — ToolRegistry + ProviderFactory only；Workers 和 HTTP routes 不是扩展点
