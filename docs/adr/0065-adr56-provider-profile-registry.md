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

## 关联

- ADR-22（LLM provider abstraction——本 ADR 是其配置/注册层补全，传输抽象不动）
- ADR-54（对话核心为最大消费者）/ ADR-55（embedding 可选声明、doctor 派生探测）
- `.harness/FINDINGS-install-flow.md` P4/N1/N5/N6
- Hermes 参照：providers/base.py（ProviderProfile）、hermes_cli/config.py（单权威加载）
