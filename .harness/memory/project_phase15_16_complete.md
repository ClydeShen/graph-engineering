---
name: project-phase15-16-complete
description: Phase 15+16 完成于 2026-06-12，全 16 阶段收口为 1.0 候选；479 tests；ADR-48/49；活体验证清单在 implementation-notes
metadata: 
  node_type: memory
  type: project
  originSessionId: 436c29a8-5ba4-483c-896d-79c7a265b32f
---

Phase 15 (deploy-everywhere) + Phase 16 (memexos-one) 完成（commits 61c7d01c→b92f686b，479 tests，tsc clean）。**全 16 个 roadmap 阶段收口，1.0 候选。**

**Phase 15**（ADR-48）：TD-M 关账——gateway 收敛 Node 22（`@hono/node-ws` 是稳定路径，hono.dev 文档展示的 `upgradeWebSocket` from '@hono/node-server' 在 1.19.x 不存在——文档陷阱已记 ADR）；TD-G 关账（isPairedAsync DB 读穿透）；memex doctor（8 检查，erased_at 链验规则落地）/backup/restore/service/profiles；install.sh+ps1；deploy/ 六服务 compose + hardened override。**活体验证**：Node 网关 REST+WS、容器化全栈 E2E（scope+OCC 写穿 6 服务）、备份→恢复→链验证全周期。iii 镜像 0.19.2 vs dev 0.11.2 版本漂移（scheduled trigger provider 缺失，已记遗留）；iii install 脚本硬依赖 jq。

**Phase 16**（ADR-49）：skills search/install/inspect 双 registry + skills-guard 8 类模式（红线测试：8 恶意样本全标记+干净样本零误报；findings 未确认不落盘）；eval 指标三维（命中率/留存率/压缩比——**Lesson 的 Ebbinghaus 列在 procedural_memory 不在 semantic**，活体跑通时纠正）+ journey 7 步（活体跑 2 次：基线+回归对比）+ 0.05 容差回归门；SECURITY.md/QUICKSTART/CHANGELOG/SHA-256SUMS（损坏一字节即失败有测试）；遥测零实现（D-3：图本来就是自己的遥测）。

**发布流程**（ADR-49 D-1 固定）：doctor → tests+tsc → journey → 快照对比 → checksums → tag。

**活体遗留清单**：implementation-notes Phase 16 节有合并清单（三平台安装、LLM-keyed journey、registry API 核验、docker exec containment、Pi-SDK 终端、email 生产绑定、iii 版本钉住）。

[[project-phase14-complete]]
[[project-planning-harness-drift]]
