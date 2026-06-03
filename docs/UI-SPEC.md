# Graph-OS Console — UI Specification
> 版本：v1.0 · 2026-06-03
> 范围：Phase 3 实现参考。Phase 2 只需满足后端集成约束（见下文），前端不在 Phase 2 交付。

---

## 原则

1. **后端优先**：dashboard 的所有技术决策为后端架构让步。后端暴露什么 API，dashboard 就消费什么。dashboard 不驱动后端协议选型。
2. **只读**：MVP Console 无写入操作。特权注入、SOP 锁定等写操作推迟到 Phase 4+。
3. **框架轻量**：图渲染引擎独占 canvas，React 只管外围 UI 壳。

---

## 技术栈（锁定）

| 层 | 选型 | 版本约束 | 职责 |
|---|---|---|---|
| 脚手架 | **Vite** | latest | `<100ms` 启动，原生 Worker 支持 |
| UI 壳 | **React + TypeScript** | React 19 | 外围按钮 / Slider / 告警列表，不管 canvas |
| 图渲染 | **@antv/g6** | **v5（锁死）** | 独占 canvas，力导向布局，节点生长动画 |
| 多线程 | **Web Worker（Vite 原生）** | 浏览器原生 | force layout 计算，不阻塞主线程 |
| 指标图表 | **Recharts** | latest | 页面二折线图，React 管理，不与 canvas 竞争 |
| 样式 | **Tailwind CSS** | v3 | 工业冷色调，无组件库 |
| 数据获取 | **HTTP polling（原生 fetch）** | — | 后端现有 REST 端点；升级协议由后端决定 |

### Web Worker 正确语法（Vite）

```typescript
// ✅ Vite 打包可识别
const worker = new Worker(
  new URL('./workers/graph-layout.worker.ts', import.meta.url),
  { type: 'module' }
);

// ❌ Vite 打包时找不到
const worker = new Worker('graph-worker.js');
```

Worker 文件放 `src/workers/graph-layout.worker.ts`。

---

## 页面架构

```
┌─────────────────────────────────────────────────────┐
│  Global Status Ribbon  (常驻顶部，HTTP poll 1s)      │
└──────────┬────────────────┬───────────────┬──────────┘
           ▼                ▼               ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │  Page 1      │ │  Page 2      │ │  Page 3      │
   │  因果拓扑     │ │  内核指标    │ │  挂起告警    │
   └──────────────┘ └──────────────┘ └──────────────┘
```

---

## 常驻组件：Global Status Ribbon

**展示内容**

```
[ Engine: ACTIVE ] │ [ Live Scopes: 14 ] │ [ Suspended: 0 ✅ ] │ [ Slots: 2/4 ]
```

**数据接口**（Phase 2 Gate 2 必须实现）

```
GET /v1/sys/health
```

期望响应结构：
```json
{
  "engine_status": "active",
  "live_scopes": 14,
  "suspended_count": 0,
  "active_slots": 2,
  "max_slots": 4
}
```

**轮询频率**：1000ms。后端如后续支持 SSE/WS，dashboard 升级消费方式，不提前设计。

---

## Page 1：因果拓扑画布（Causal Topology）

### 核心视觉效果

- **节点生长动画**：新节点出现时气泡弹出效果（G6 v5 `animate` + `enter` 配置）
- **边生长动画**：新边出现时从 source 到 target 的延迟绘制
- **增量 diff**：轮询返回新数据时，与现有图状态做 diff，只对新节点/边执行 animate，不重绘全图
- **力导向布局**：G6 v5 `ForceLayout`，计算委托给 Web Worker

### 节点类型与颜色

| event_type | 颜色 | 形状 |
|---|---|---|
| `task_spawned` | `#4A9EFF`（蓝） | circle |
| `tool_invoked` | `#7C5CFC`（紫） | diamond |
| `memory_updated` | `#3DD68C`（绿） | circle |
| `context_oom_throttled` | `#FF4D4F`（红） | hexagon |
| `scope_closed` | `#888`（灰） | circle |
| 其他 | `#555` | circle |

### 交互

- 鼠标滚轮缩放、画布平移、节点拖拽
- 单击节点：右侧 Inspector 面板展示节点 payload
- **Filter 工具栏**（React 管理，G6 外部）：
  - 按 `event_type` 多选过滤（隐藏不选类型的节点/边）
  - 按时间范围过滤（slider，隐藏范围外节点）
  - 搜索 `scope_id` 或 `entity_id`，高亮匹配节点

### 数据接口（Phase 2 Gate 2 必须实现）

```
GET /v1/scopes/:id/topology
```

期望响应结构（邻接表）：
```json
{
  "scope_id": "uuid",
  "tip_version_hash": "sha256hex",
  "nodes": [
    {
      "id": "version_hash",
      "entity_id": "uuid",
      "event_type": "task_spawned",
      "timestamp": 1774883100,
      "payload_summary": {}
    }
  ],
  "edges": [
    {
      "source": "version_hash_a",
      "target": "version_hash_b",
      "event_type": "task_spawned"
    }
  ]
}
```

**轮询频率**：2000ms。对比 `tip_version_hash`，哈希未变则跳过渲染。

### G6 v5 核心配置草图

```typescript
const graph = new Graph({
  container: 'topology-canvas',
  layout: {
    type: 'force',
    workerEnabled: true,        // 委托给 Web Worker
    preventOverlap: true,
  },
  animation: true,
  node: {
    style: (d) => ({
      fill: NODE_COLOR_MAP[d.data.event_type] ?? '#555',
    }),
    // 节点进入动画（气泡弹出）
    animates: {
      enter: [{ fields: ['opacity', 'r'], duration: 300, easing: 'ease-out' }],
    },
  },
  edge: {
    type: 'quadratic',
    style: { endArrow: true, stroke: '#444' },
    animates: {
      enter: [{ fields: ['opacity'], duration: 200 }],
    },
  },
});
```

---

## Page 2：内核指标折线图（Kernel Dashboard）

### 展示内容

- **并发槽位占用率**：`active_slots / max_slots` 实时折线
- **队列积压**：`pending_dispatch` 事件水位折线
- 时间轴：最近 1min / 5min / 1hr 切换

### 数据接口

```
GET /v1/metrics/infra
```

期望响应结构：
```json
{
  "timestamp": 1774883120,
  "active_slots": 2,
  "max_slots": 4,
  "queue_backlog": 5,
  "avg_dequeue_ms": 3.4
}
```

**轮询频率**：2000ms。时序数据在前端 `useRef` 中维护环形缓冲（最近 300 个点）。

### Recharts 配置

```tsx
<LineChart data={metricsBuffer}>
  <Line dataKey="active_slots" stroke="#4A9EFF" dot={false} isAnimationActive={false} />
  <Line dataKey="queue_backlog" stroke="#FF4D4F" dot={false} isAnimationActive={false} />
  <Tooltip />
</LineChart>
```

`isAnimationActive={false}`：高频刷新时关闭 Recharts 内置动画，避免闪烁。

---

## Page 3：挂起告警（Suspended Alerts）

### 展示内容

- 以红色卡片列出所有 `status = 'suspended'` 的 Scope
- 每张卡片展示：`scope_id`、`error_reason`、`frozen_at`、`unconverged_nodes_count`

### 数据接口

```
GET /v1/scopes/audit/suspended
```

期望响应结构：
```json
[
  {
    "scope_id": "uuid",
    "status": "suspended",
    "error_reason": "context_oom_throttled",
    "frozen_at": 1774883112,
    "unconverged_nodes_count": 3
  }
]
```

**轮询频率**：5000ms（低频，列表变化慢）。

> **注意**：`P0-E`（watchdog.ts:196 `'terminated'` → `'suspended'`）必须在 Phase 2 Day 0 修复，否则此页面数据永远为空。

---

## Phase 2 后端集成约束（非 dashboard 实现，是 Phase 2 设计护栏）

以下约束写入 Phase 2 PLAN.md，Phase 2 实现时遵守，不需要额外工作量：

| # | 约束 | 验证方式 |
|---|---|---|
| C1 | Phase 2 所有新 event_type 必须写入 `execution_event_log`，不得绕过走私有表 | Gate 2：新事件在 `execution_event_log` 可查 |
| C2 | Gateway 路由命名空间 `GET /v1/*` 保持可扩展，Phase 2 新路由不破坏现有端点 | Gate 2：原 Gate 1 端点仍返回预期响应 |
| C3 | Phase 2 新增 Entity 的 `predecessor_hash` 必须正确挂接到现有图，哈希链不断裂 | Gate 2：`GET /v1/scopes/:id/topology` 返回连通图 |

**Gate 2 新增验收项**：
- `GET /v1/scopes/:id/topology` 返回有效邻接表 JSON（节点 + 边），dashboard 可离线渲染静态快照
- `GET /v1/sys/health` 返回系统状态摘要
- `P0-E` 修复验证：OOM 触发后 `scope_lineage.status = 'suspended'`（非 `'terminated'`）

---

## 目录结构（Phase 3 实现时参考）

```
packages/console/
├── src/
│   ├── pages/
│   │   ├── topology/       # Page 1: G6 canvas + Inspector
│   │   ├── kernel/         # Page 2: Recharts metrics
│   │   └── alerts/         # Page 3: Suspended list
│   ├── components/
│   │   ├── StatusRibbon.tsx
│   │   └── FilterToolbar.tsx
│   ├── workers/
│   │   └── graph-layout.worker.ts  # Web Worker: force layout
│   ├── hooks/
│   │   ├── useTopologyPoll.ts
│   │   ├── useMetricsPoll.ts
│   │   └── useAlertsPoll.ts
│   └── lib/
│       └── topology-diff.ts        # 增量 diff：新节点/边识别
├── index.html
├── vite.config.ts
└── tailwind.config.ts
```

---

## 暂不实现（Phase 4+）

- 时间旅行轨迹条（Replay Timeline）
- 特权注入面板（需 D-11 + POST 写操作）
- 涌现工作流画布（需 D-10 OLAP，Phase 3+）
- 3D 全局拓扑视图
- SOP 模板锁定
