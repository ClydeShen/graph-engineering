---
name: phases17-20-complete
description: Phase 17-20 全弧 code-complete（2026-06-12 单会话）+ 质量收口；561 tests；活体批次清单是唯一遗留
metadata: 
  node_type: memory
  type: project
  originSessionId: e8bcb43a-3355-48ca-9d33-7e36419e24df
---

Phase 17–20 于 2026-06-12 单会话完成（commits b5f4bda6→83f3068b），479→561 tests，tsc clean，console next build 9/9。

- **17 mcp-connector-ecosystem**（ADR-50/0059）：optional-mcps catalog、MemexOAuthProvider（shared，PKCE+token 落盘）、memex mcp 命令族、McpClientWorker config+stdio+filter+list_changed、能力图最小增量
- **18 first-run-experience**：能力图主体（migration 017、bindCategory Snapshot 链、冷启动背书注入 process-agent-turn、memex capability、bundled meta-skills）、WSL2（wsl.ts/doctor/install.sh/ADR-48 附录）、onboarding 扩展、connect telegram、Email 生产绑定（imapflow/nodemailer）、Terminal --agent Pi-SDK 模式；ADR-51 升 accepted
- **19 console-and-artifacts**（ADR-52/0061）：artifact=哈希落盘+读模型+payload 引用（修订了"写图事件"原案——OCC 槽位红线）、erase 级联 2.5、packages/console（Next.js15+G6v5，根 tsc 排除）、/v1/metrics/infra+suspended 审计、skill --scope global|profile
- **20 autonomous-assistant**（ADR-53/0062）：capability_search/install 两段审批（guard 报告入审批正文+TOCTOU 重扫）、ask_user（migration 019）、凭据保险库（MEMEX_VAULT_KEK 信封加密+crypto-shred+redact/inject 边界）、browser 工具（类目解析+docker bridge+截图 artifact）、journey 5a-5d 网球场北极星、skills client+guard 下沉 shared

**Why:** 下个会话不要重做任何 17-20 的设计或实现；ROADMAP 各节已标 ✅。

**How to apply:** 唯一遗留 = 活体批次（implementation-notes 各 Phase 节合并清单）：三平台 install 真机、docker containment+memex-browser 镜像、/approve //answer /pair 渠道命令路由、Telegram/IMAP/OAuth 活体、Pi agent 模式活体、G6 画布视觉、journey 5a-5d 活体跑、iii version pinning（installer 接口需活体验证，勿凭空猜 VERSION env）。关联 [[capability-graph-adr51]]、[[phase15-16-complete]]。
