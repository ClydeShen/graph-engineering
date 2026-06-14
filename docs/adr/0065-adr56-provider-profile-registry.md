# ADR 56｜ProviderProfile 声明表与配置单权威

status: accepted（2026-06-12 实现落地；提纲源自同日 fuller 会话拍板）
日期: 2026-06-12

---

## 上下文

活体批次最大发现（P4 加重）：onboarding 写出的 `config.json providers[]` 在全系统
范围内**没有任何消费者**——gateway/workers 只读 env；doctor 探测 gateway 用错端口、
不读 .env；dev.mjs 自己解析 .env 而 CLI 不解析。配置真相四分裂
（.env / config.json / iii-config.yaml / ~/.pi/agent），每个消费面手写平行数据。

Hermes 标本给出结构性疫苗：**ProviderProfile 注册表**——每个 provider 声明一次
（providers/base.py），auth 解析、setup 向导、doctor 健康检查、模型目录、运行时
路由全部从同一注册表**派生**，永不脱节。`.env` 只放秘密，`~/.hermes/config.yaml`
是设置的单一权威（".env.example 注释明言 LLM_MODEL is no longer read from .env"）。

用户指令：支持的主流 provider（LLM、embedding 等）与 Hermes 对齐。

## 决策

### D-1：内置 ProviderProfile 声明表（@graph/shared）

单个 TS 模块内置声明表，每条 profile 含：`name` / `displayName` / `baseUrl` /
`envVar`（key 的约定环境变量名）/ `authType` / `signupUrl` / `modelsUrl`（动态目录）/
`apiMode`（openai-compatible | anthropic-native）/ `supportsEmbedding`。

主流矩阵对齐 Hermes：OpenRouter / Anthropic / OpenAI / Ollama（本地+云）/ Gemini /
GLM / Kimi / MiniMax / Hugging Face 等——绝大多数走 openai-compatible 一条传输
路径（ADR-22 既有抽象），Anthropic 原生为第二路径。

**不做** Hermes 的插件目录机制（`~/.memex/plugins/model-providers/`）——15 个版本
养成的产物，本弧 YAGNI；自定义 provider 走 config 的 `custom` 条目，表的读取口
即未来插件化的现成插缝。

### D-2：派生原则（核心纪律）

onboarding 选单、doctor 探测项、运行时 provider 构造、模型目录拉取，**一律从声明表
派生，禁止任何消费面维护平行数据**。doctor 的 per-provider 健康检查、embedding
可达性探测（ADR-55 D-4）自动生成。

### D-3：config.json 单权威 + 秘密分离

- `~/.memex/config.json` 是设置的单一权威（schema 温和扩展现有 MemexConfig）
- `apiKey` 字段支持字面值或 `env:VAR_NAME` 引用；onboarding 默认写 env 引用
- 优先级：process env > config.json > 内置默认
- gateway/workers/CLI/对话核心（ADR-54）/doctor 全部经 `loadMemexConfig()` 同源
  消费——`LLM_BASE_URL`/`LLM_MODEL` 等散装 env 降级为兼容回退，不再是主路径

### D-4：fallback 链激活

现有 schema 的 `priority` 字段从摆设变语义：按优先级排序即 fallback 链；错误分类
（ADR-55 D-1 同一分类器）决定重试 vs 切换。首版仅 chat provider 链，credential
轮转不做（YAGNI）。

### D-5：启动编排收敛

- dev.mjs：启动前检查 config.json，缺失则引导 `memex onboard`（gate）
- dev.mjs 给 console 传净化后的 env（剔除 `PORT`，console 回归 3000）——修 N1
- gateway 端口单一来源（config `gateway.port`），terminal/doctor/console 同源——修
  N6 与 terminal 3000/4000 漂移
- CLI 统一解析 .env（修 N5：doctor 与 dev.mjs 的配置源分裂）

## 后果

- "onboarding 配了但没人用"（P4）根除；doctor/onboard/运行时从此结构上不可能脱节
- Anthropic-only / OpenRouter-only / 本地 Ollama 等主流单 provider 场景开箱可用
- ADR-22 的 createLLMProvider 单构造路径保留，构造参数来源改为声明表+config

## 补充（2026-06-14：活体 onboarding 暴露的三处结构修正）

用户手动 onboarding NVIDIA 时连环暴露三类问题，逐一根因修复（非打补丁）：

### D-6：OpenAI-compatible URL 契约（单一规则）

`OpenAICompatibleProvider` 原硬编 `${baseUrl}/v1/chat/completions` 与 `…/v1/embeddings`，
但声明表的云 baseUrl **已含版本段**（`api.openai.com/v1`、`integrate.api.nvidia.com/v1`、
Gemini `…/v1beta/openai`）→ 运行时发**翻倍路径** `…/v1/v1/…` → 严格网关全 404，chat+embedding
双失败。本地（裸 host，无 `/v1`）与 DeepSeek（宽容网关）掩盖了它，而活体测试恰好全是本地。

修复：抽 `openaiUrl(baseUrl, route)` 单一规则——检测路径含 `/v\d` 即"已版本化"直接拼 route，
否则补 `/v1`。provider（chat+embed）与 fetch-models 共用，全码库一条 URL 契约。**baseUrl 两种
写法都合法**：版本化（OpenAI SDK 约定，声明表采用）或裸 host（本地服务），互不翻倍。

### D-7：onboarding 交互流程对齐 Hermes `hermes model`

- **先 key 后选模型**：拿到 key 即拉 provider 的 `/models`，recommended 置顶让用户选，
  拉不到（离线/无端点）回退手敲——取代"一上来盲敲 model name"。
- **本地 provider 确认端点**：local profile 的 baseUrl 是声明表默认，onboarding 让用户
  确认/改端口（默认预填）；改后的 URL 既拉模型又写 config（运行时同端点）。Windows
  `localhost`→IPv6 `::1` 优先的坑在 USER_MANUAL §5.1 给出 `127.0.0.1` 排错提示。
- **embedding picker 列全部 `supportsEmbedding`**：过滤从"有默认模型"放宽为"能 embed"，
  无默认者标 `(choose a model)` 走同款选单；`custom` 补问 baseUrl 成为任意 OpenAI-compatible
  embeddings 端点（Voyage/Cohere/Jina）的逃生口。reuse / reuse-pick 两路：一键默认 vs 同
  provider 自选模型，不强制。

### D-8：embedding flag 校正（声明表数据）

`supportsEmbedding` 系手维护、会漂移。穷尽审计 5 个标 false 的 provider：
- **NVIDIA → true**（默认 `baai/bge-m3`，对称模型，NIM `/embeddings` 只收 `{model,input}`，
  无需 `input_type`）；**OpenRouter → true**（2025 标准化 OpenAI 形 `/embeddings`，默认
  `openai/text-embedding-3-small`）——两者均为 flag 漂移。
- **MiniMax/nv-embedqa 仍 false**：`embo-01`/nv-embedqa 非对称，需 query/db（passage/query）
  类型参数，对称 `embed()` 满足不了——**有据排除非疏漏**，profile 内注释说明。未来 `embed()`
  若学会 `input_type` 再评估。

## 关联

- ADR-22（LLM provider abstraction——本 ADR 是其配置/注册层补全，传输抽象不动）
- ADR-54（对话核心为最大消费者）/ ADR-55（embedding 可选声明、doctor 派生探测）
- `.harness/FINDINGS-install-flow.md` P4/N1/N5/N6
- `.harness/implementation-notes.md`（2026-06-14 onboarding 弧逐项根因）
- Hermes 参照：providers/base.py（ProviderProfile + `fetch_models()`）、hermes_cli/config.py（单权威加载）
