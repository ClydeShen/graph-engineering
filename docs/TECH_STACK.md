# Graph-Native Agent Runtime — Tech Stack

> Phase 1 實施可完全確認的技術選型。  
> **核心修正（2026-06-01，ctx7 核實）**：iii 是現成引擎二進制，非本項目自行編寫。我們的代碼分三層：iii 引擎（安裝）、TypeScript Workers（iii-sdk）、TypeScript Control Plane Daemon（iii-sdk + pg）。

---

## 1. iii Engine（現成二進制，非自行實現）

> **官方來源（ctx7 核實）**：  
> GitHub: https://github.com/iii-hq/iii  
> 官方文檔: https://github.com/iii-hq/iii/blob/main/docs/quickstart.mdx  
> Worker 管理: https://github.com/iii-hq/iii/blob/main/docs/how-to/managing-container-workers.mdx

```bash
# 安裝 iii 引擎
curl -fsSL https://install.iii.dev/iii/main/install.sh | sh
iii --version
```

| 模塊 | 說明 | 我們的關係 |
|------|------|-----------|
| Engine Core | Worker 注冊、Function 路由、WebSocket 管理 | **使用**，不修改 |
| QueueModule | 持久化任務隊列（Redis 或 PostgreSQL backend） | **配置**（生產指向我們的 PostgreSQL） |
| CronModule | 定時觸發（Phase 2+，使用 Redis adapter） | **配置** |
| StreamModule | WebSocket 連接狀態（Redis） | **使用** |

**ADR 與 iii 的邊界說明**：ADR 08–11 描述的 HWM 水位線、Pulse-Fetch LISTEN/NOTIFY、DashMap 訂閱路由、Worker 幂等，是我們的 **Control Plane Daemon** 負責實現的橋接邏輯（PostgreSQL → iii 路由），不是 iii 引擎本身的 Rust 內部代碼。

**iii 的 storage backend 選擇**：
```yaml
# iii config (生產)
storage:
  adapter: postgres   # 指向我們的 PostgreSQL 實例，iii 管理自己的內部表
  connection_string: ${DATABASE_URL}
```

---

## 2. Worker Layer（TypeScript + `iii-sdk`）

所有 Worker 和 Control Plane Daemon 均使用 TypeScript，通過 `iii-sdk` npm 包連接 iii 引擎。

### 2.1 核心依賴

| 包 | 版本約束 | 用途 | ADR | 官方來源 |
|----|---------|------|-----|---------|
| `iii-sdk` | latest | Worker 注冊、Function 觸發；`registerWorker()` + `registerFunction()` | 系統基礎 | [github.com/iii-hq/iii](https://github.com/iii-hq/iii)（ctx7 核實） |
| `pg`（或 `postgres`） | `pg` v8.x | 直連 PostgreSQL 執行 Writable CTE INSERT / Scope DDL | ADR 03–05 | [github.com/brianc/node-postgres](https://github.com/brianc/node-postgres)（ctx7 核實） |
| `pg-listen` | v3.x | PostgreSQL LISTEN/NOTIFY 監聽，Control Plane Daemon 核心機制 | ADR 09 | [github.com/andywer/pg-listen](https://github.com/andywer/pg-listen) · [npm](https://www.npmjs.com/package/pg-listen) |

```bash
# Worker 安裝
npm install iii-sdk pg pg-listen
```

### 2.2 Worker 連接模式

```typescript
// 所有 Worker 通用模板（docs/adr/0022-adr21-reflection-track-trigger-spec.md 相關）
import { registerWorker } from 'iii-sdk';
import { Pool } from 'pg';

const iii = registerWorker(process.env.III_URL ?? 'ws://localhost:49134');
const db  = new Pool({ connectionString: process.env.DATABASE_URL });
// db 賬號：SELECT/INSERT only（無 DDL 權限，ADR 05）

iii.registerFunction(
  { id: 'worker::task_spawned' },
  async (event: TaskSpawnedEvent) => {
    // 1. Knapsack Slicing（確定性執行軌道）
    // 2. 可選：mem::reflect（發散性反思軌道）
    // 3. LLM inference
    // 4. canonicalJson → Writable CTE INSERT
  }
);
```

### 2.3 Control Plane Daemon（核心橋接層）

Control Plane Daemon 是**我們自己實現**的 TypeScript 進程，職責：
1. 橋接 PostgreSQL `pg_notify` → `iii.trigger()` 路由（Pulse-Fetch，ADR 09）
2. 執行三階段筑巢協議（DDL，ADR 05）—— 使用 DDL 權限的獨立連接池
3. 維護 HWM 水位線（`bus_state` 表，ADR 08）
4. 直寫 `context_oom_throttled` / `sub_scope_resolved`（ADR 13 supplement / ADR 23）
5. 運行拓撲收斂看門狗（ADR 19）

```typescript
// Control Plane 核心橋接邏輯
import createSubscriber from 'pg-listen';
import { registerWorker } from 'iii-sdk';

const subscriber = createSubscriber({ connectionString: process.env.DATABASE_URL });
const iii = registerWorker(process.env.III_URL ?? 'ws://localhost:49134');

await subscriber.connect();
await subscriber.listenTo('iii_engine_channel');

subscriber.notifications.on('iii_engine_channel', async (raw) => {
  const { id } = JSON.parse(raw);  // ≤64B pulse（ADR 09）

  // 只讀連接池點查完整事件
  const event = await readOnlyPool.query(
    'SELECT * FROM execution_event_log WHERE id = $1', [id]
  );

  // 更新 HWM（ADR 08）
  await updateHWM(id);

  // 路由到對應 Worker Function
  await iii.trigger({
    function_id: `worker::${event.rows[0].event_type}`,
    payload: event.rows[0],
  });
});
```

### 2.4 Pi Agent（Task Worker 宿主）

| 包 | 用途 |
|----|------|
| `@earendil-works/pi-coding-agent` | Pi Coding Agent CLI，執行型 Worker 宿主 |

> **跨平台注意**（STATE.md 風險 #9）：spawn Pi Agent 時需 `{ shell: true }`

### 2.5 TypeScript 核心工具函數

**canonical_json**（ADR 02，`docs/ADR_v4.md` § ADR 02，可直接復制）：
```typescript
function canonicalJson(payload: unknown): string {
    if (Array.isArray(payload)) return JSON.stringify(payload.map(canonicalJson));
    if (payload && typeof payload === 'object') {
        const sorted = Object.fromEntries(
            Object.keys(payload as object).sort()
                .map(k => [k, JSON.parse(canonicalJson((payload as Record<string,unknown>)[k]))])
        );
        return JSON.stringify(sorted);
    }
    return JSON.stringify(payload);
}
```

**mem::reflect 調用接口**（ADR 21，`docs/adr/0022-adr21-reflection-track-trigger-spec.md`，可直接復制）：
```typescript
const reflection = await iii.trigger<MemReflectInput, MemReflectOutput>({
  function_id: 'mem::reflect',
  payload: {
    query_text:   string,
    trigger_type: 'cold_start' | 'conflict_detected' | 'macro_planning',
    w_max:        number,
    scope_id:     string,
  },
});
```

---

## 3. Wasm Tokenizer（Rust → Wasm，Node.js 加載）

> **保留 Rust 的唯一原因**：JS tokenizer 對 tiktoken BPE（特別是 `cl100k_base`、`o200k_base`）的邊界字節計數存在物理量綱偏差，在 W_max 臨界點會引爆 Context OOM，直接擊穿 ADR 13/14 防線。Rust 編譯到 Wasm 消除偏差，同時保護 Node.js 事件循環不被長文本 BPE 編碼阻塞。

| 包 | 用途 | 官方來源 |
|----|------|---------|
| `@dqbd/tiktoken` | tiktoken 官方 Wasm 包（Rust `tiktoken-rs` 編譯到 Wasm），Node.js 2行接入 | [github.com/dqbd/tiktoken](https://github.com/dqbd/tiktoken) · [npm](https://www.npmjs.com/package/@dqbd/tiktoken) |

```typescript
// ADR 15 — Wasm Tokenizer 旁路，Node.js 側（可直接復制）
import { get_encoding } from '@dqbd/tiktoken';

const enc = get_encoding('cl100k_base');   // 或 'o200k_base'

function countTokens(text: string): number {
    const tokens = enc.encode(text);
    return tokens.length;
}
```

**支持的模型指紋**（ADR 15 原文）：`cl100k_base`（GPT-4/3.5）、`o200k_base`（GPT-4o）、`llama3`（需確認 Wasm 包支持情況）。

---

## 4. PostgreSQL（數據層 SSOT）

### 4.1 版本要求

**PostgreSQL 15+**（推薦 16）

需求來源：`PARTITION BY LIST`（ADR 04）、`GENERATED ALWAYS AS STORED`（ADR 20 supplement）、`DEFERRABLE INITIALLY DEFERRED`（ADR 23）、jsonb 路徑操作符（ADR 19）。

### 4.2 必裝 PostgreSQL 擴展

| 擴展 | 版本 | 用途 | ADR | 官方來源 |
|------|------|------|-----|---------|
| `pgcrypto` | contrib 內置 | `digest(content_input, 'sha256')` — Version Hash 計算 | ADR 02 | [postgresql.org/docs/current/pgcrypto.html](https://www.postgresql.org/docs/current/pgcrypto.html) |
| `pgvector` | v0.7.0+（HNSW）；v0.8.0+（iterative_scan，Phase 3） | `vector(1536)` 列類型 + HNSW 索引 | ADR 17, 20 | [github.com/pgvector/pgvector](https://github.com/pgvector/pgvector)（ctx7 核實） |

> **pgvector 官方文檔核實（ctx7, github.com/pgvector/pgvector README）**：
> - `m=16, ef_construction=64` 是 HNSW 內置默認值（可自定義：`WITH (m = 16, ef_construction = 128)`）
> - 過濾後候選集稀疏時建議 `SET hnsw.ef_search = 100` 或 `200`
> - 過濾器在索引掃描**後**執行（不下推到索引），0.7.x 和 0.8.x 均如此
> - `SET hnsw.iterative_scan = strict_order` 為 v0.8.0 新增，可自動補充掃描覆蓋率

### 4.3 關鍵 DDL 片段（可直接復制）

完整 DDL 見 `docs/ADR_v4.md` § ADR 04（Scope 分區）、§ ADR 20（四張記憶表）。  
tsvector BM25 列補充：`docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md`。

**Scope 分區 + OCC 約束（ADR 04）**：
```sql
CREATE TABLE execution_event_log_scope_{id}
PARTITION OF execution_event_log FOR VALUES IN ('{id}');

ALTER TABLE execution_event_log_scope_{id}
ADD CONSTRAINT uk_scope_composite_occ_{id} UNIQUE (predecessor_hash, scope_id);

CREATE INDEX IF NOT EXISTS idx_scope_{id}_vector_hnsw
ON execution_event_log_scope_{id}
USING hnsw (embedding vector_cosine_ops);
```

---

## 5. LLM / Embedding Provider（ADR 22）

統一協議：OpenAI-compatible REST (`/v1/chat/completions` + `/v1/embeddings`)

| Provider | 接入 | 場景 |
|----------|------|------|
| `ollama` | OpenAI-compatible (`--api`) | 本地開發首選 |
| `llama.cpp` server | OpenAI-compatible | 本地高性能 |
| `mlx-lm` (macOS) | OpenAI-compatible wrapper | Apple Silicon |
| OpenAI API | 原生 | 雲端生產 |

**iii-config.yaml**（`docs/adr/0023-adr22-llm-provider-abstraction.md`，可直接復制）：
```yaml
llm:
  provider: openai_compatible
  base_url: http://localhost:11434/v1
  model: llama3.2
  api_key: ""

embedding:
  provider: openai_compatible
  base_url: http://localhost:11434/v1
  model: nomic-embed-text
  dimensions: 1536
  api_key: ""
```

---

## 6. 部署約束

| 組件 | 要求 |
|------|------|
| iii Engine | 通過官方安裝腳本安裝；生產配置指向 PostgreSQL backend |
| PostgreSQL | v15+，pgcrypto + pgvector 已安裝；推薦 Docker `pgvector/pgvector:pg16` |
| Redis | iii CronModule 等需要（可選，視 iii 配置而定） |
| Node.js | v22+（Workers + Control Plane）；啟動命令 `node --import tsx/esm`，`--loader tsx` 在 v22 已廢棄 |
| Bun | v1.x（HTTP Gateway）；Gateway 使用 `export default { port, fetch }` Bun server API，Node.js 不自動啟動 HTTP 服務器 |
| Windows 開發 | Docker 或 WSL2（STATE.md 風險 #10） |
| Pi Agent 跨平台 | `{ shell: true }` spawn（STATE.md 風險 #9） |

---

## 7. 概念性引用（Conceptual References）

| 概念 | 來源 | URL | 應用位置 |
|------|------|-----|---------|
| Blockchain Ledger Philosophy | Nakamoto, S. (2008). *Bitcoin: A Peer-to-Peer Electronic Cash System* | https://bitcoin.org/bitcoin.pdf | Execution Graph SSOT，append-only，predecessor_hash 鏈 |
| Event Sourcing (CQRS/ES) | Fowler, M. — *Event Sourcing* | https://martinfowler.com/eaaDev/EventSourcing.html | append-only 事件日誌，BIGSERIAL 確定性重放 |
| Choreography Pattern | Hohpe, G. & Woolf, B. — *Enterprise Integration Patterns* | https://www.enterpriseintegrationpatterns.com/patterns/messaging/EventBus.html | 無中央控制代碼，Worker 訂閱驅動 |
| Optimistic Concurrency Control | Kung, H.T. & Robinson, J.T. (1981). "On Optimistic Methods for Concurrency Control." *ACM TODS 6(2)* | https://dl.acm.org/doi/10.1145/319566.319567 | Writable CTE 因果倒置，UNIQUE 約束裁決 |
| Chaos Engineering | Basiri, A. et al. (2016). *Chaos Engineering*. Netflix | https://netflixtechblog.com/the-netflix-simian-army-16e57fbab116 | RFC §6.2 故障隔離驗證 |
| Ebbinghaus Forgetting Curve | Ebbinghaus, H. (1885). *Über das Gedächtnis* | https://en.wikipedia.org/wiki/Forgetting_curve | Episodic/Procedural 30 天時效衰減，`recency_score` |
| Four-tier Memory Model | Tulving, E. (1985). "Memory and Consciousness." *Canadian Psychology* | https://doi.org/10.1037/h0080017 | ADR 20 四層記憶物理架構類比 |
| Knapsack Problem | Kellerer, H. et al. (2004). *Knapsack Problems*. Springer | https://link.springer.com/book/10.1007/978-3-540-24777-7 | ADR 13 命名來源，Token 預算填充算法 |
| Reciprocal Rank Fusion (RRF) | Cormack, G.V., Clarke, C.L.A., Buettcher, S. (2009). "Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods." *SIGIR 2009* | https://dl.acm.org/doi/10.1145/1571941.1572114 | BM25+HNSW 融合，K=60 常數 |
| Deterministic Replay | Gray, J. & Reuter, A. (1992). *Transaction Processing: Concepts and Techniques*. Morgan Kaufmann | https://www.elsevier.com/books/transaction-processing/gray/978-1-55860-190-0 | RFC §6.1 SHA-256 碰撞驗證 |
| MemR3 Architecture | MemR3: Memory-Retrieval and Reflection for Multi-Agent Systems (2024) | https://arxiv.org/abs/2512.20237 | ADR 21 集中式 `mem::reflect` 設計依據 |
| MemGPT / Letta | Packer, C. et al. (2023). "MemGPT: Towards LLMs as Operating Systems." *arXiv:2310.08560* | https://arxiv.org/abs/2310.08560 | ADR 21 集中式反思接口設計參考 |
| agentmemory HybridSearch | rohitg00/agentmemory（ctx7 核實：`BM25_WEIGHT=0.4, VECTOR_WEIGHT=0.6`；RRF `k=60` 來自源碼） | https://github.com/rohitg00/agentmemory | ADR 20 supplement RRF 權重來源（vector=0.6, bm25=0.4） |

---

## 8. 可直接復制的代碼引用索引

| 代碼片段 | 文檔位置 |
|---------|---------|
| TypeScript `canonicalJson()` | `docs/ADR_v4.md` § ADR 02 |
| Scope 分區 + OCC 約束 + HNSW DDL | `docs/ADR_v4.md` § ADR 04 |
| `episodic_memory` / `semantic_memory` / `procedural_memory` CREATE TABLE | `docs/ADR_v4.md` § ADR 20 |
| tsvector BM25 列補充（三張表） | `docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md` |
| BM25+HNSW RRF 混合查詢模板 | `docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md` |
| procedural_memory 四信號冷啟動查詢 | `docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md` |
| `ScopeConvergenceTracker` 邏輯（看門狗） | `docs/ADR_v4.md` § ADR 19 |
| 看門狗終審 SQL（NOT EXISTS 修正版） | `docs/ADR_v4.md` § ADR 19 |
| `△_padding` 自適應公式 | `docs/ADR_v4.md` § ADR 16 |
| `mem::reflect` Worker 調用接口 | `docs/adr/0022-adr21-reflection-track-trigger-spec.md` |
| `LLMProvider` / `EmbeddingProvider` 接口 | `docs/adr/0023-adr22-llm-provider-abstraction.md` |
| `iii-config.yaml` LLM 配置 | `docs/adr/0023-adr22-llm-provider-abstraction.md` |
| `context_oom_throttled` INSERT SQL | `docs/adr/0024-adr13-supplement-context-oom-degradation.md` |
| `scope_lineage` DDL（Phase 3） | `docs/adr/0025-adr23-nested-scope-propagation.md` |
| `convergence_gate` payload 結構 | `docs/ADR_v4.md` § ADR 18 |
| pgvector 強制預過濾查詢模板 | `docs/ADR_v4.md` § ADR 17 |
| Wasm Tokenizer Node.js 接入（`@dqbd/tiktoken`） | 本文檔 §3 |
| Control Plane Daemon pg-listen 橋接模板 | 本文檔 §2.3 |
