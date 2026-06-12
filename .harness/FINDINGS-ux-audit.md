# FINDINGS — 挑剔用户 UX 审计（2026-06-12，多终端模拟）

方法：Claude Code 以 background task 启动 `npm run dev`（终端1），独立 bash 调用模拟用户
新开终端执行 doctor / chat / backup / onboard / service / skills / mcp / capability 及各错误路径
（终端2/3），全程读 dev.log + docker psql 直查图状态做交叉验证。

状态标记：✅ 本批修复 | 📝 仅记录（引擎侧/环境因素）| ⏳ 既有遗留

| # | 严重度 | 发现 | 处置 |
|---|---|---|---|
| U1 | **严重** | HWM 从未持久化：`advanceHwm` 只 UPDATE 不 INSERT，`bus_state` 始终 0 行 → 每次启动 `readHwm`=0，重放全部历史事件（上限 1000，本次 572 条）。`sub_scope_resolved` 重放会**真实调用 LLM**（重启即烧 token + boot 期 fetch failed 风暴） | ✅ UPSERT |
| U2 | 高 | U1 的重放风暴压垮 workers 事件循环 → iii-sdk 心跳断线 → 30 秒内三轮重连重注册 → 引擎为每轮 cron 生成新 UUID 且旧 job 不清理 → **cron 重复触发**（embedding-backfill 11:40 被 2 个 job 各触发一次）。WS error ×27（空 payload）同源 | ✅ 随 U1 消失；引擎侧 cron 去重问题 📝 |
| U3 | 高 | 裸 `memex`（无参数）直接进 connect 多选向导；非 TTY 下崩 `uv_tty_init EBADF` | ✅ 裸 memex → help；connect 加非 TTY 守卫 |
| U4 | 高 | `memex onboard` 非 TTY 同样崩 `uv_tty_init EBADF`（脚本/CI 场景必炸） | ✅ 非 TTY 守卫 |
| U5 | 高 | `memex backup` 失败信息为空：`pg_dump failed (exit 1): `。本机 PG 跑在 docker、宿主无客户端工具——这是常见部署形态，ENOENT 被吞 | ✅ ENOENT 识别 + 安装/docker exec 指引 |
| U6 | 中 | gateway 未启动时 `memex chat` 报 `memex-terminal failed: fetch failed`——零可操作性 | ✅ 包装为"cannot reach gateway at \<url\> — is it running?" |
| U7 | 中 | `memex chat --scope not-a-uuid` 报 `conversation turn failed`；真因（uuid 语法错误）只在服务端日志 | ✅ UUID 预检 + catch 回传 err.message |
| U8 | 中 | 管道喂 REPL（`printf "hello\n/quit\n" \| memex chat`）第一条消息被吞——行未串行化，/quit 立即 close | ✅ 行队列串行化 |
| U9 | 低 | `pulse.replay trigger skipped — function not found` 文案永远如此（实际是 fetch failed），且 err 对象带双重完整堆栈，单条 WRN 几十行 | ✅ 文案改真因 + 只记 message |
| U10 | 低 | `memex service` 把 service-files/ 写进 cwd，repo 内运行污染 git status | ✅ .gitignore |
| U11 | 低 | iii `Trigger type scheduled not found` ERROR ×1，出现在第三轮重连注册中；我们代码无 'scheduled' 注册（N2 已修），疑似引擎重注册路径残留 | 📝 随 U1/U2 消失则关账 |
| U12 | 低 | iii-config.yaml watcher 误报：repo 根目录任何文件创建都触发 `reload: config changed`（diff 0/0/0 无害但有噪音） | 📝 引擎侧 watcher 粒度 |
| U13 | 信息 | console 首页 500（Turbopack PostCSS 子进程 0xc0000142）**仅发生在沙箱内启动的 dev stack**；独立无沙箱运行正常（307）。用户正常 `npm run dev` 不受影响 | 📝 沙箱环境因素 |
| U14 | 低 | doctor `channels: no channels configured`——用户 onboarding 时 telegram 验证失败被静默跳过的既有遗留 | ✅ token getMe 验证通过（@memememex_bot）；.env + config.json channels 引用写入；doctor "1 channel(s), tokens present"；long-poll 活体启动 |
| U20 | **高** | gateway-bot 是独立进程（自启动入口）但 dev.mjs 从不启动它——配好 telegram 渠道也永远没有 bot 在跑（U14 的深层根因）；且 long-poll 启动无日志，活渠道与死渠道在日志里无法区分 | ✅ dev.mjs 条件启动 [bot] 进程（telegram/discord/email env 存在时）+ long-poll 启动标记日志；过时 "/pair" 提示文案修正（ADR-54 后渠道直接对话） |
| U15 | 低 | REPL 对话中每个 turn 回显 `⟶ [memory_updated] {"event_id":N}` 诊断行——聊天界面的纯噪音 | ✅ REPL 抑制 memory_updated 回显（其他 trail 事件保留） |
| U16 | 中 | dev.mjs 不回收 console 端口 3000：残留 console 进程时 Next.js 静默换 3004，banner 仍写 3000——用户打开的是旧实例 | ✅ freePort(3000) |
| U17 | 低 | Topology/Artifacts 页要求手动输入 scope_id (uuid)——用户无从得知 uuid，没有 scope 列表/选择器 | ✅ GET /v1/scopes 列表端点（limit 钳制 1-200）+ ScopePicker 下拉（intent·短id·status），两页接入，活体验证联动加载 |
| U18 | **高** | console Skills 页永远 "no exported skills"：gateway `/v1/skills` 默认读 `./skills`（gateway cwd），CLI 装到 `~/.memex/skills`——两边永远对不上；且 detail 路由只接受 64-hex id，按名字安装的技能点开 404 | ✅ 默认根改 memexHome()/skills + detail 接受安全目录名（防穿越正则保留） |
| U19 | 中 | Skills 详情面板把 `{"content":"..."}` 原始 JSON 整包渲染（console 没解析 envelope）——此前被 U18 的空列表掩盖 | ✅ 解析 content 字段 |

## 浏览器 UI 走查（agent-browser，2026-06-13）

- Topology：✅ 渲染 3 节点因果图 + Inspector 面板；StatusRibbon（Engine OK / Live Scopes / Suspended / Slots）正常
- Kernel：✅ metrics 图表正常（刚启动 1/300 points）
- Alerts：✅ "none — all scopes healthy"
- Artifacts：✅ 空 scope 提示 "no artifacts in this scope" 正确
- Skills：U18/U19 修复后 ✅ 列表 3 技能 + SKILL.md 正文干净渲染
- 自动化盲区：canvas 节点点击（force-graph 自带命中检测不认合成事件）——Inspector 的节点详情需人工点验
- 觉察项：Kernel 图红点 pending backlog ≈560（历史任务积压，调度器按 slots 限流消化中）——非 bug，但首屏数字偏大易引起误读

## 通过项（无摩擦）

- `memex --version` / `--help` / 未知子命令报错 ✓
- `memex doctor` 全绿、探测准确 ✓
- `memex chat -m` 单发（stdout/stderr 分离）✓
- `--scope` 续聊跨 turn 图记忆（ZEBRA-77 回忆成功）✓
- `memex skills inspect` / `mcp list` / `capability list` ✓
- `memex service` 文件生成 + 指引 ✓
- dev.log 检修口（ANSI 剥离、boot 分隔头）✓
- 健康端点、scope 创建、trail 广播 ✓

## U1 证据链

```
bus_state:           0 rows                  ← advanceHwm UPDATE 永远命中 0 行
execution_event_log: max(id)=1949, 572 rows
boot 日志:           pulse.replay ×572, 其中 sub_scope_resolved (484,524,561,597,641,…)
                     → SubScopeResultWorker.onSubScopeResolved → Gemini chat → fetch failed
11:34:50 workers 注册第1轮 → 11:35:11 第2轮(Overwriting WARN ×16) → 11:35:14 第3轮
11:35:15 WS error ×27 → 11:40:00 embedding-backfill 被 2 个 cron job 重复触发
```
