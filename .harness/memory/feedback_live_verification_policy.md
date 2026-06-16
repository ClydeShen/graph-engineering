---
name: feedback_live_verification_policy
description: "Live-verification policy — \"done\" classifier drawn at the environment boundary"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ce065d28-6967-4ae2-8256-90e924fe9b18
---

2026-06-13 fuller 会话确立(用户逐步同意):**「done」分两级,线划在环境边界。**

- **logic-done**(单测绿即可):纯逻辑面 —— 协议编解码、状态机、签名数学、哈希链、redaction 正则、解析。正确性完全由代码决定,环境无关。
- **live-done**(必须一次真实活体冒烟):任何正确性**依赖被测试 mock 掉的真实边界**的面 —— 网络栈/OS/runtime 行为、真实外部对端、部署基质(docker/systemd)。这类只有 logic-done 时**必须显式打 `unverified-live` 标签 + 落地条件,绝不标 ✅**。

**Why:** channel 修复证明(undici Happy-Eyeballs、dev.mjs PATH 重复键 —— 都是自家 runtime/OS,非外部对端),跨环境边界的 bug 单测结构性看不见。implementation-notes 里 Phase 12 Slack 重投、Phase 15 iii trigger、Phase 16 列错位四次复现同一教训。线**必须含自家 runtime/OS**(否则正好漏掉触发讨论的那两个 bug)。

**How to apply:**
1. 节奏 = **门控前进(gated forward)**:下一件工作必须是*本环境能活体闭环*的;否则归 `unverified-live + 落地条件`(学 Phase 13 A2A 那个做对了的范式),不假装做完。
2. 优先级用 **leverage test**:哪个 unverified-live 项一旦是坏的,作废的其它结论最多 → 先验它(安全/承重墙类最高)。
3. 警惕 **Proxy Signal**(CLAUDE.md §5):绿灯测的是一个不发生的行为(实例:[[project_execute_bash_containment_unwired]] —— Phase 14 绿靠 execute_bash 永不调用的函数的单测)。

本机活体能力(用户 2026-06-13):Slack workspace ✓、docker ✓、IMAP ✗。相关:[[project_channel_connectivity_fix]]、[[project_channel_hermes_deep_dive]]。
