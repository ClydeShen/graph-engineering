---
name: feedback-browser-tests-use-agent-browser
description: 浏览器测试一律用 /agent-browser CLI，不用 Claude in Chrome 扩展
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d8eac67b-bd9e-4b12-9478-e6bc9f1f8675
---

用户指示（2026-06-13）：所有浏览器上的测试都用 /agent-browser（agent-browser CLI）。

**Why:** Chrome 扩展在该环境连不上（两次尝试均失败）；agent-browser 是 headless CLI，
可直接在 bash 里驱动（open/snapshot/fill/click/screenshot），且本项目 console 走查已验证可行。

**How to apply:** 测 console/dashboard UI 时直接 `agent-browser open http://localhost:3000/...`
→ `snapshot -i` 拿 ref → 交互 → `screenshot` 验证。注意 bash 工具沙箱会让 Next.js Turbopack
PostCSS 子进程崩（0xc0000142）——启动 dev stack 和 agent-browser 命令需 dangerouslyDisableSandbox。
canvas 类组件（force-graph）不认合成事件，命中检测盲区需截图人工判断。相关 [[project-ux-audit-u1-u19]]。
