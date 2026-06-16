---
name: project_execute_bash_containment_unwired
description: execute_bash docker containment was unwired — now WIRED (B) + network=none live-verified; browser containment 8/8
metadata: 
  node_type: memory
  type: project
  originSessionId: ce065d28-6967-4ae2-8256-90e924fe9b18
---

**RESOLVED 2026-06-13 (B 接线):** execute_bash 现接 docker backend。`exec-backend.ts`
+`resolveExecBackend()`(EXEC_BACKEND=docker→docker;不可达→**null fail-closed**,绝不回退宿主);
server.ts 走 `execFile('docker', buildDockerRunArgs(cmd,{network:'none'}))`,local 走原 exec。默认仍 local
(行为不变,gateway 189 测试 + tsc 绿,+1 单测锁「默认 local」不变量)。**network=none 活体验证过**:
容器接口数=1(仅 lo)、egress DNS bad address(对比 browser bridge 有 eth0、能打 telegram)。ADR-47 声明现与代码一致。
残留:生产要隔离需显式 EXEC_BACKEND=docker(doctor 已提示);镜像默认 alpine:3;容器内 uid=0 被 cap-drop 阉割(加 --user 更稳)。
原始发现记录 ↓

2026-06-13 (/goal fuller, 代码 research 发现):

**`execute_bash` 的 docker 容器化从未接线。** `packages/gateway/src/mcp/server.ts:491-498`
的 execute_bash 无条件走宿主 `child_process.exec`(CommandGate + scrubEnv),无 backend
选择。`buildDockerRunArgs`/`approvalRequiredForBackend`(exec-backend.ts)唯一真实消费者
是 `browser` 工具(server.ts:729 真 `execFile('docker')`)。
→ ADR-47 D-4 / Phase 14「红线全绿」的 "in-container commands cannot reach the host" 对
execute_bash **是假的**;绿灯是 **Proxy Signal**(测了 execute_bash 永不调用的函数)。
非裸奔(CommandGate + scrubEnv 两道真实宿主防御),但**缺容器化隔离那道**。设计意图本是
execute_bash→docker network=none(exec-backend default 'none';doctor.ts:252 prefer docker)。

**browser docker 容器化:8/8 活体验证通过**(docker 29.4.3 本机,alpine 探针跑 browser 确切参数向量):
根只读✓ /tmp可写但noexec✓(堵死写马再跑) CapEff=0✓ NoNewPrivs:1✓ 零宿主挂载✓
inspect 全参数落实✓ egress=bridge能外联(设计取舍)。残留硬化缺口:容器内 uid=0 root(被cap-drop阉割,加 --user 更稳)。

**待决策(C 已验地板是实的,证据齐):** execute_bash 怎么办 —
- **A 改声明对齐代码**:承认 execute_bash=宿主纵深防御 by design,docker 容器化=browser 专属,下修 ADR/notes 措辞 + 标注死代码 bypass 规则。
- **B 接线代码对齐声明**:execute_bash 接 docker backend(EXEC_BACKEND=docker→buildDockerRunArgs+execFile,network none),让承诺变真。

关账:Phase 14/20 carried "docker exec containment verification" 的 browser 路径 = live-done。
依据 [[feedback_live_verification_policy]]。
