# ADR 22｜LLM/Embedding Provider 抽象层与最小化原则

status: accepted  
日期: 2026-05-31

---

## 上下文

系统多处需要调用语言模型或嵌入模型：Worker 推理、ConflictResolverWorker 语义合并、TemplateProposalWorker 模板提炼、`mem::reflect` 内部 embedding 生成、记忆写入时的语义向量化等。

不同部署场景对模型的要求差异极大：本地开发环境可能只有 llama.cpp 或 ollama；生产环境可能使用 OpenAI-compatible API（本地或云端）；macOS 可用 mlx。若将具体模型调用硬编码在实现里，系统将与特定 API 强耦合，无法在离线或受限环境运行。

---

## 决策

### 1. 最小化 LLM 调用原则

**系统设计应尽可能避免引入 LLM 调用。** 凡是可以用确定性算法（SQL、正则、图拓扑计算）完成的功能，禁止用 LLM 替代。

每一处不可避免的 LLM 或 Embedding 调用必须在 ADR 或实施规范中**显式标注**，说明：
- 调用原因（为何无法避免）
- 调用类型（推理模型 vs 嵌入模型）
- 是否可降级为本地模型

### 2. Provider 抽象接口

Provider 接口定义在 `@graph/shared/src/llm/provider.interface.ts`，所有 LLM/Embedding 调用经此抽象，不允许在 Worker 或业务代码中直接构造 HTTP 请求：

```typescript
// packages/shared/src/llm/provider.interface.ts

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface EmbedResult {
  vector: number[];
  /** 始终为 false — 嵌入调用不计入 Worker token 预算（ADR 22 D-1） */
  countedAgainstBudget: false;
}

// 推理模型（用于 Worker 推理、冲突合并、模板提炼）
interface LLMProvider {
  chat(messages: ChatMessage[], opts?: { temperature?: number }): Promise<string>;
}

// 嵌入模型（用于 mem::reflect、记忆写入向量化）
// Phase 1：仅单条 embed()。embedBatch() 未实现，按需补充。
interface EmbeddingProvider {
  embed(text: string): Promise<EmbedResult>;
}
```

`EmbedResult.countedAgainstBudget: false` 是类型级保证：调用方无需手动判断，TypeScript 编译层面确认嵌入调用不扣减 W_max。

### 3. 支持的 Provider 实现（iii-engine 配置驱动）

```yaml
# iii-config.yaml
llm:
  provider: openai_compatible   # 支持所有 OpenAI-compatible API
  base_url: http://localhost:11434/v1  # ollama / llama.cpp / lmstudio 等
  model: llama3.2
  api_key: ""   # 本地运行时可为空

embedding:
  provider: openai_compatible
  base_url: http://localhost:11434/v1
  model: nomic-embed-text   # 或 text-embedding-3-small 等
  dimensions: 1536
  api_key: ""
```

**支持的 Provider 清单**（Phase 1 实现优先级）：

| Provider | 协议 | 场景 |
|----------|------|------|
| OpenAI-compatible | REST `/v1/chat/completions` + `/v1/embeddings` | 所有场景（本地/云端统一） |
| ollama | OpenAI-compatible 模式（`--api`） | 本地开发首选 |
| llama.cpp server | OpenAI-compatible 模式 | 本地高性能 |
| Apple MLX (macOS) | OpenAI-compatible wrapper（mlx-lm serve） | macOS 本地 |
| Anthropic Claude | 原生 API（可选适配） | 云端生产 |

**实现策略**：Phase 1 只实现 OpenAI-compatible 一种 Provider（`OpenAICompatibleProvider`，位于 `@graph/shared`），覆盖 ollama/llama.cpp/lmstudio/OpenAI/任意兼容端点。其他 Provider 按需适配，接口不变。

### 4. 当前系统中必须使用 LLM 的位置（显式清单）

| 位置 | 类型 | 原因 | 可本地运行 |
|------|------|------|-----------|
| Worker 推理 | 推理模型 | 核心功能，无法避免 | ✅ |
| ConflictResolverWorker 语义合并 | 推理模型 | 语义理解不可用确定性算法替代 | ✅ |
| TemplateProposalWorker 模板提炼 | 推理模型 | DAG 抽象需要语义理解 | ✅ |
| `mem::reflect` 内部 embedding | 嵌入模型 | HNSW 向量检索依赖向量表示 | ✅ |
| 记忆写入时 embedding 生成（episodic/semantic/procedural） | 嵌入模型 | 同上 | ✅ |

**显式排除**（不引入 LLM）：
- `memory::write_guard` 隐私过滤：纯 regex，不用 LLM
- 拓扑收敛看门狗判定：纯 SQL，不用 LLM
- Knapsack Slicing：纯图算法，不用 LLM
- OCC 裁决：数据库唯一约束，不用 LLM

---

## 后果

- Worker 和业务代码与具体模型完全解耦，可在纯本地环境（无网络）运行整个系统
- 新增 Provider 只需实现两个接口，不需修改任何 Worker 代码
- 所有 LLM 调用点有显式文档记录，便于审计和成本控制
- ADR 21 的 `mem::reflect` 内部 embedding 调用通过 `EmbeddingProvider` 接口执行

---

## 关联 ADR

- **ADR 05** — Worker 权限隔离：Worker 不持有 Provider 凭证，凭证统一在 iii-engine 配置
- **ADR 14/16** — Context Window 安全容量：embedding 调用消耗不计入 Worker △_padding
- **ADR 21** — `mem::reflect`：内部 embedding 通过 `EmbeddingProvider` 接口
