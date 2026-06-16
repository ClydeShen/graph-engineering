---
name: capability-graph-adr51
description: 能力图七项拍板（2026-06-12）——ADR-51 骨架已写，落点分摊 Phase 17/18/20，Phase 17 执行前必读
metadata: 
  node_type: memory
  type: project
  originSessionId: e8bcb43a-3355-48ca-9d33-7e36419e24df
---

能力图（capability-as-graph）设计于 2026-06-12 Fuller 会话收口，七项决定写入 `docs/adr/0060-adr51-capability-graph-schema.md`（status: proposed 骨架）+ ROADMAP 新增"能力图"总括节 + Phase 17/18/20 正文修订。

七项：① 图为语义权威、config 仅运维信息（MCP tools.include/exclude 因兼容留 config 但定性为期望态输入）；② 三层节点 Category/Implementation/Tool，边按形态分型（exposes=MCP/worker tool，consumes=skill/CLI——官方 Skill 规范验证 skill 不暴露 tool）；③ Tool Entity=注册的可调用签名，CLI 子命令走 payload 投影不建节点，facade 注册后升格；④ agent 在场内选，meta tool 动词族 search_catalog/install/inspect 无 select；⑤ 背书=采样→场景条件化（episodic ANN）→注入排序+显式标注；⑥ 归因=共现计数打底+切换因果对强样本；⑦ 落点分摊 17（install 写 Entity + surface_changed 观察）/18（三层 schema 主体+绑定 Snapshot 链）/20（消费+背书 v2 进网球场 journey）。

**Why:** Phase 17 若按原文执行会建 config-only 注册表、事后回填——ADR-51 先行避免返工；Phase 20 agent 自主选能力若无背书则建在裸 description 匹配上，S3 核心价值缺位。

**How to apply:** Phase 17 discuss/plan 启动时与 ADR-50 一起读 ADR-51；Phase 18 实装时把骨架补全为 accepted。开放问题（实装时决）：能力 Entity erase 级联细节、切换因果对 schema、Category 词表治理。经三重官方交叉验证（agentskills.io 规范、MCP 规范 tools/list 动态性、agent-browser 实测 discovery stub 形态）。关联 [[phase15-16-complete]]。
