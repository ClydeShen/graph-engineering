# Tree-sitter Worker Integration Spec — TemplateProposalWorker (Optional)

status: accepted
日期: 2026-06-05
type: implementation-spec (not a core ADR — supplements TemplateProposalWorker design from RFC §7.1-7.2)

---

## 背景

TemplateProposalWorker 在 `scope_closed` 后从执行图 DAG 提炼 Golden Template，写入 `procedural_memory`（RFC §7.1-7.2，ADR 07）。

**现有能力**：
- WL 图核计算 `topology_embedding`（ADR 25）
- 意图文本嵌入 `intent_embedding`（Phase 3）
- iii-lsp Worker 提供 LSP（Language Server Protocol）能力

**缺口**：当执行图来自**代码领域**任务（e.g., "调试 TypeScript 编译错误"、"重构 Python 类"），Scope 的 payload 包含代码片段和符号引用。TemplateProposalWorker 目前不提取代码实体（函数、类、导入），也不分析代码依赖拓扑，导致代码领域模板的结构信息丢失。

Tree-sitter 作为**可选的 AST 提取层**填补此缺口。

---

## 决策

### 能力边界

| 层 | 工具 | 职责 |
|----|------|------|
| AST / 实体提取 | Tree-sitter | 解析代码片段，提取函数名、类名、导入符号、调用图 |
| Language Server 协议 | iii-lsp Worker | 类型推断、跨文件跳转定义、诊断信息 |
| WL 图核嵌入 | TemplateProposalWorker | 拓扑结构嵌入（与代码语言无关） |

Tree-sitter 和 iii-lsp Worker **不重叠**：Tree-sitter 是语法层（字节串 → AST），iii-lsp 是语义层（类型系统、跨文件引用）。两者可同时启用，互不替代。

---

### 触发条件：仅限代码领域

Tree-sitter 调用**必须**由 payload 类型守卫保护。以下两个条件**同时满足**时才调用：

1. `scope.payload.domain === 'code'`（或等效字段，由控制面在 Scope 创建时注入）
2. `scope.payload.code_snippets` 非空数组

非代码领域的 Scope（e.g., `domain === 'research'`、`domain === 'planning'`）：Tree-sitter **不调用**，跳过此步骤，无需回退逻辑。

---

### 集成点：TemplateProposalWorker 扩展步骤

在现有流程（读取 DAG → 计算 WL 嵌入 → 写 `procedural_memory`）的**读取 DAG 之后、写入之前**插入可选步骤：

```
scope_closed
  → read DAG from execution_event_log
  → [optional] if code domain: parse code_snippets with Tree-sitter
      → extract code_entities: { functions, classes, imports, calls }
      → write code_entities to template_graph.metadata.code_entities (JSONB)
  → compute WL topology_embedding
  → write procedural_memory record
```

`template_graph.metadata.code_entities` 是新增的可选 JSONB 字段，NULL 表示非代码领域。

---

### Tree-sitter 集成方式

- **运行时**：Node.js Worker 进程内，通过 `node-tree-sitter` npm 包调用（无独立进程）
- **语言 grammar**：按需加载（`tree-sitter-typescript`、`tree-sitter-python` 等）
- **调用模式**：同步解析（Tree-sitter Node.js binding 是同步 API）

**提取输出格式**（写入 `template_graph.metadata.code_entities`）：

```typescript
interface CodeEntities {
  functions: string[];      // 函数/方法名
  classes: string[];        // 类名
  imports: string[];        // 导入的模块/符号
  calls: string[];          // 函数调用图（调用目标名）
  language: string;         // 'typescript' | 'python' | 'go' 等
}
```

---

### 错误处理

Tree-sitter 解析失败（语法错误、不支持的语言）时：
1. 记录 `WARN: tree-sitter parse failed for scope {id}: {error}`
2. **跳过** code_entities 提取（不中断模板提炼流程）
3. `template_graph.metadata.code_entities` 保持 NULL

即 Tree-sitter 是**尽力而为**（best-effort）的可选增强，不是核心依赖。

---

### 此 Spec 不包含的内容

- 跨文件依赖分析（属于 iii-lsp Worker 职责）
- Tree-sitter grammar 的训练或自定义（使用官方 grammar）
- 代码相似性搜索（复用 WL 图核；代码领域的拓扑结构通过现有机制捕获）
- 数据库 schema 变更（`template_graph` 已是 JSONB，可存储任意 metadata）

---

## 后果

- 代码领域模板额外携带结构化实体信息，提升跨代码 Scope 的模式可识别性
- 非代码领域：零性能影响，零代码路径变更
- 依赖新增：`node-tree-sitter` + 对应语言 grammar（可选安装）
- 未来 Phase：可基于 `code_entities` 实现代码实体级的跨 Scope 聚类（目前不实现）

---

## 关联文档

- **RFC §7.1-7.2** — TemplateProposalWorker 原始设计
- **ADR 07** — 内存热图生命周期（TemplateProposalWorker 触发时机）
- **ADR 25** — WL 图核拓扑嵌入（Tree-sitter 不替代此计算）
- **ADR 35** — Worker/Tool 边界（Tree-sitter 在 Worker 进程内，不跨越边界）
