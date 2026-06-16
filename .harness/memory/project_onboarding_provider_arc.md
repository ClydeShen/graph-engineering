---
name: project_onboarding_provider_arc
description: "Onboarding + LLM provider arc (2026-06-14) — model pick-list, embedding breadth, /v1 doubling root cause, memex console; 11 commits pushed"
metadata: 
  node_type: memory
  type: project
  originSessionId: bb96dcd5-9f1b-4e6b-a833-e94661782d9a
---

2026-06-14 单会话弧:手动 onboarding NVIDIA 连环暴露问题,逐项**根因**修复(非打补丁),11 commit 已推送到 origin/master(`fd5fd7c7..4379761c`)。承接 [[project_console_live_test_session]]。

**链条(commit):**
1. `92552366` 先问 key 再拉 `/models` 选单(recommended 置顶),取代盲敲 model name。新 `shared/llm/fetch-models.ts`(best-effort,永不抛)。
2. `bcfaa702` embedding picker 过滤从"有默认模型"放宽为"能 embed",3→9 provider;`custom` 补 baseUrl 成任意 OpenAI-compat embeddings 逃生口。
3. `ed38d4da` 本地 provider 确认/可改端点(新 `resolveBaseUrl`);改后 URL 既拉模型又写 config。Windows `localhost`→IPv6 坑。
4. `525e004f` NVIDIA→supportsEmbedding true(`baai/bge-m3` 对称,无需 input_type)。
5. `d4b21be1` embedding reuse 路径携带已编辑的本地端点。
6. `1f6635a9` reuse 加 `reuse-pick`:同 provider 自选模型,不强制默认。
7. **`b2cd332c` 系统性根因(/systematic-debugging)**:`OpenAICompatibleProvider` 硬编 `${baseUrl}/v1/...`,但云 profile baseUrl 已含 `/v1` → 运行时发翻倍 `/v1/v1/` → 严格网关全 404,chat+embed 双失败。本地(裸host)+DeepSeek(宽容)掩盖,活体全本地。**我此前的 NVIDIA fix 运行时其实 404,非功能性**——这才是"nvidia 不孤"的真义。修:抽 `shared/llm/openai-url.ts :: openaiUrl(baseUrl,route)` 单一规则(检测 `/v\d` 不翻倍),provider+fetch-models 共用。curl 实证。
8. `a80336f1` flag 审计收口:OpenRouter→true(2025 标准化 /embeddings,默认 `openai/text-embedding-3-small`);MiniMax 留 false 但注释说明非对称(需 query/db,同 nv-embedqa)有据排除。回归护栏锁 openrouter+nvidia flag。
9. `09ae9626` docs:ADR-56 补充 D-6/D-7/D-8;configuration.md baseUrl 两写法都行。
10. `4379761c` onboarding "Next steps" `npm run dev`→`memex console`(产品命令,拉栈+开app);console.ts 同类泄漏一并去。

**关键架构事实(勿忘):** baseUrl 两种约定并存——版本化(OpenAI SDK style,声明表用)vs 裸 host(本地)。`openaiUrl` 是全码库唯一 URL 规则。Anthropic provider 不属翻倍类(base 恒裸),未动。

**未解残留:**
- **authenticated 活体 embedding 往返未验**(本会话无可用 key;URL 形已 curl 证实,带认证那跳留给用户重 onboarding)。
- **真正一键 `memex start`**:`memex console` 底层仍 spawn `npm run dev`,需 repo-root+npm。打包化属 deploy 弧(ROADMAP 15),未做。
- `connect/telegram.ts validateBotToken` 用裸 fetch 非硬化 `telegramFetch`(channel-http.ts),受限网络误报;落地条件=把 channel-http 提到 @graph/shared。

**Gate:** llm 54 + onboard 10 + provider-profiles 9 测试绿,root tsc clean。逐项根因留档在 `.harness/implementation-notes.md`(2026-06-14 多节)。
