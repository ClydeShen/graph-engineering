---
name: emergence-benchmark-paper
description: "Faithful A/B + learning-curve benchmark of 越用越聪明. Final: HOLDS end-to-end after the L2 fix (crystallize corrected order, not executed path). Academic doc, master e3c50597."
metadata: 
  node_type: memory
  type: project
  originSessionId: 631b156a-499a-43fe-acef-2fa43aa55b8f
---

## ⚡ Scaled validation（master `c9b59f38`）— 论文 §5.5
18 步 DAG + 6 quirk。**关键方法学发现**：第一版 quirk 符合 CI/CD 常识→强模型全推断→**0 效应**(OFF也0门失败)；**「隐藏结构」≠「任务大小」**。重设计成**反直觉规则**(schema后于api/lint后于test/scan前于build/migrate后于test/monitoring后于deploy)才咬住。结果:**A/B(8臂) ON 38.3±0.7/0.1 vs OFF 43.5±3.4/2.8,Δ12%**(11步的翻倍,效应随隐藏结构放大)；**学习曲线(10)降13%(46.7→40.7,门失败4-5→1)**——越用越聪明 scales,但**渐进且部分**:停在最优(38)上方一个 quirk,高复杂度下晶化6条反直觉规则+模板累积更难=诚实天花板;下个L2目标=模板 consolidation。数据 ab-1781570646578/curve-1781569692836.json,apparatus commit 2584fd7e。**「null结果≠回路失败」**站更稳(可能是任务无隐藏结构可学)。

## ⚡ 翻正 — L2 已修，越用越聪明成立（master `e3c50597`，fix `08c2af7f`）
基线学习曲线平 → 深层根因：**晶化复刻「实际执行路径」含冷启动错误**（LLM 逐字蒸馏 "run_tests(initial)→containerize→run_tests(retry)" 当顺序）→ 下次照做=重复犯错。**修复=template-proposal.worker prompt 加 `lesson` 字段,要求蒸馏「纠正后的最优序」(避开观察到的错误/依赖写成"X must precede Y"/每步一次)**,附进正向模板 content+intent_description(被注入字段);匿名 template_graph 仍管 recall;lesson 可选(无则不变)。+2单测,168 workers绿。**修复后曲线:26(冷,错一次)→24×9 零门失败=阶跃学习,越用越聪明端到端成立**(数据 curve-1781567981220.json)。通用教训:学习系统须蒸馏「本该怎样」非记录「实际怎样」否则强化初次错误。论文§5全重写(5.1基线平/5.2两层诊断/5.3修复/5.4下降曲线)+摘要/结论翻正。
（下方为诊断当时原始记录,保留作过程档）

---

2026-06-16，master `5cb0ff8c`（单会话从 freeze 一路推进到这里）。用户要求：全过程记录，产出学术论文式 benchmark 文档作项目背书。

## 权威产物
- **`docs/benchmarks/emergence-loop-validation.md`** — 学术结构（摘要/引言三因果链 L1-L3/背景含两缺陷 D1D2/装置/A实验/B学习曲线/有效性威胁/可复现/结论）。
- 可复现 harness：`scripts/eval/faithful-ab/{dag,seed,agent,run}.ts`。原始 JSON：`.harness/analysis/faithful-ab/`（含 commit+模型）。

## 装置（忠实，#29 后才可能）
11 步微服务 DAG + 2 非显然 quirk（run_tests←containerize 测试在容器内跑；gen_migrations←add_deps）。goal 按字母列步骤不泄露依赖。**真 MCP spawn→claim→complete 驱动真 #29 收敛**（complete_task 终结 task_spawned，checkConvergence+writeScopeClosed，无垫片；只触发时机替代 control-plane）。学习曲线晶化=直接调 `TemplateProposalWorker.onScopeClosed`。模型 gpt-oss-120b，temp0，embedding 此次工作（key 已加载）。

## 结果（活体真数据）
- **A/B 8臂 = L1 成立**：ON 24.0±0.0 / 0 门失败 / 召回100%；OFF 25.5±0.9[24-26] / 0.8 门失败（6/8撞quirk）。delta 6%。注入**确定性消除** OFF 75%概率撞的非显然quirk失败。量级小=强模型自推DAG其余，效应=隐藏不可推结构大小（2 quirk）。
- **学习曲线 10跑 = 平的**：26,24,26,26,26,26,26,26,26,26；first-third 25.3→last-third 26.0（-3%）。**越用越聪明端到端不成立。**

## 核心诊断（论文中心发现）
回路**转了**：每跑收敛、晶化（模板1→10）、召回（探针证 memReflect 召回2模板）。L3(收敛,#29修好)+召回都работ。**断点=L2晶化保真**：
- 晶化 intent = 泛泛"做了什么"summary（"Create a microservice with scaffolding…containerization…deployment"），**不含顺序教训**。
- template_graph = WL规范化匿名拓扑（`{"from":"n0","to":"n13"}`），agent 读不出步骤名/依赖。
- ⟹ 召回的工件**对任务惰性**：run10 和 run1 一样撞 quirk。对比 A/B 手写 runbook（明写顺序）有效。
**结论：越用越聪明今天不成立——不是回路不转(L3已修)，是晶化蒸馏出的工件太泛泛+匿名,传不了可操作教训(L2)。** 修向=晶化编码可操作结构(顺序/依赖约束+可读标签),非散文summary+匿名skeleton。重跑harness=核心主张的回归测试。

## 注意
- recallHit metric 是假阴性(查字面run_tests)；曲线JSON记recall=false但实际召回了——论文§6已澄清,平曲线=召回内容惰性而非无召回(更强结论)。
- 顺带2 infra发现仍在(F-INFRA-1 doctor reachable≠functional只ping;F-INFRA-2 key在.env非memex config)——未开issue。

关联：[[emergence-loop-validation]] [[feedback_live_verification_policy]] [[feedback_confidence_four_dimensions]]
