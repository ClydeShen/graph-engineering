---
name: skill-hardening-vision
description: "Future vision (NOT committed work) — borrow smart-contract concepts to \"harden\" emerged skills. Full fuller design session: postcondition predicate language + gate hysteresis + mechanical definition (contract+cached-plan) all CLOSED. Structural core reached."
metadata: 
  node_type: memory
  type: project
  originSessionId: 151d19e7-1ea8-47b6-a8d3-a25a82a9b53c
---

纯讨论 / 未来愿景（2026-06-14，多轮 + 一次 /fuller 深钻）。**🎫 GH issue [#26](https://github.com/ClydeShen/graph-engineering/issues/26)**(icebox/post-1.0, status:on-hold) + ROADMAP §Post-1.0。标记为**非待实现**——不要当排好的 Phase，无新证据不主动起工。但本轮 fuller 已把「硬化 skill」钻到接近结构核心，**有一个岔口未答，下次从那接**（见末尾）。

## 大前提
只**借用** smart-contract 概念来**升级「涌现」功能**，不做真区块链。Memex = Merkle-DAG / 哈希链接日志（append-only + 内容寻址，**无共识层** → 像 Git，不像 Ethereum）。

## 三条线索（指向同一对象）
1. **硬化 skill = 杠杆点（trim tab）**：涌现模式的相变终点。借 smart-contract 的「固化 + 前后置条件 + 内容寻址版本化」，扔掉「永久不可变 + 靠没判断换信任」。本质 = **带 deopt guard 的 JIT 热路径**：确定性是挣来的、可收回的。单机即可落地，且是 2/3 的**上游依赖**（没有硬化 skill，2/3 无物可传/可路由）。
2. **跨机器联邦** ≠ 公链（公链 node 是 replication 求共识，不要）。是 **IPFS + npm + 引用图**式：只流通脱敏的可验证工件，靠「独立重验」扩散。核心律：**信任不可转移，只有可验证性可转移**；联邦边界本身 = 一道 deopt guard。
3. **群协同** ≠ 公链节点。是 **actor 模型上的涌现专家市场**（partition 求能力，非 replication）。node 暴露**拓扑投影**（非裸 I/O、非整图）；orchestrator 按涌现专长路由（先别幻想去中心化分解 = MAS 研究前沿）；群的**路由史**积成高一层 Trail Mesh = 真正有牙齿的「更大规模涌现」。

**反复现身的同一对象** = 「去上下文的结构 hash / 后置条件等价类」：硬化的身份 + 联邦的可寻址单位 + 群路由的匹配键。**要动手从它开刀。** 注意现有 `version_hash` 是本地的（含 scope_id/entity_id），需第二个**去上下文结构 hash**。

**A2A 定位**：是 2/3 的**传输层（信封）**，非信任/涌现层（信还得自己写）。Agent Card 可扩展塞后置条件断言 = smart-contract 概念落在 A2A 信封上。Phase 13 推迟 A2A 有据（当时只委派+可见性）；2/3 正是让它「解冻」的工作负载。

---

## fuller 深钻：硬化 skill 的内部结构（本轮成果）

硬化 skill = 一个**子图模板**，四部件：**前置条件**（触发模式）/ **本体**（执行体）/ **后置条件**（保证什么）/ **身份**（去上下文结构 hash）。
生命周期：`涌现模式(软) → 晋升候选 → 硬化(确定跑,LLM出环) → 偏离/失配↑ → 降级回软(deopt)`。

三个岔口：A=晋升门、B=后置条件语言、C=本体的机械定义。逐个钻：

### 岔口 B — 后置条件谓词语言【已收口】
- **B.词汇/等价**：选 **纯拓扑**（只有类型化 entity+edge 存不存在，零值比较）。理由 = **append-only 柔术**：append-only 里没有可变「状态值」，`status=resolved` 不是值而是一个 `resolved` 事件/边的存在。**值态被架构自动转译成拓扑。** ⇒ 等价关系 = **图模式同构**（小模式可解），结构 hash = 模式规范形。**五轮的等价类幽灵入土。**
- **B.来源**：选 **混合 C** = 归纳为脊（N 条 trail 结果子图取交集 = 不变核，忠于"涌现非授权"、高度自校准）+ LLM 修剪（区分目的 vs 偶然，唯一不可替代的语义步）+ **再观察终审**（不盲信任何 oracle，持续成立才挣得硬化）。同联邦「信任挣来、要重验」律。
- **B.否定缺口**：选 **不支持否定（仅正向）**。理由：① append-only 柔术——「无 error」改写成「成功终端标记在场」（converged/success/crystallize 事件）；② **原则性限制**——靠"没坏事"定义成功的场景恰恰不该硬化（要 LLM 盯着）。否定缺口是 feature：自动把硬化限制在可正向验证的 skill。

**B 最终定义**：`后置条件 = 带锚的类型化子图模式 · 同构等价 · 结构hash=模式规范形 · 混合来源(归纳+LLM修剪+再观察) · 仅正向`。
（寄存细节：匹配锚点——前置与后置共享锚节点，是自然推论非岔口。）

### 门子系统：硬化门 vs 软化门的迟滞【已收口】
用户问「代谢率 vs 吸收率谁高」。结论 = **难硬化（吸收门高）/ 易软化（代谢门低）**，代谢 > 吸收。三据：① **后果不对称**（错误硬化=无LLM静默规模化执行错误,爆炸半径大;错误软化=多付点LLM钱,自纠）;② **波普尔证伪不对称**(证实弱/一次后置失败是强证伪);③ **免疫系统**(慢授耐受/快攻危险信号)。两修正:软化区分**契约违反 vs 不适用**(只对前者扣命)+ 再硬化走**短跑道**(历史不变核挂起非丢弃)。外加 **Ebbinghaus 慢衰减钟**(久未触发→回缓刑)。N 是调参旋钮非结构决定。

---

### 岔口 C — 硬化 skill 机械上到底是什么？【已收口】
（自首:早前「本体=一串固定 association」是未检验假设=重放。打磨完后置条件后,替代项被激活。这是杠杆对象最深、且决定 2/3 可否用的一问。）

**用户拍板 = C：契约为主 + 缓存计划为提示。**
- **保证 = 契约**(可移植,=结构hash,=发往2/3的单位);**本体 = 缓存快路径**优先试,步骤失败或后置没达成→**deopt回LLM**重新达成并刷缓存。计划本地不出境,只契约出境。
- 被否:A 重放/固定程序(脆+不可移植,发往2/3无用);B 纯契约(丢了JIT快路径)。
- 理由:缝合全部五轮——第1轮(借保证扔不可变:契约耐久/计划可弃)、第2轮(联邦发契约本地重挣)、第3轮(群广告契约)、JIT隐喻(缓存计划=编译热路径/契约=函数签名/deopt=guard失败回解释器)、deopt获得**两个触发器**(后置没达成=契约违反 + 缓存步骤失败=执行漂移)。

---

## 结构核心已达（收敛）

全景自洽,五梁落定:
- **身份** = 去上下文结构 hash(后置条件规范形)
- **后置条件** = 带锚类型化子图 · 同构等价 · 混合来源 · 仅正向(append-only 柔术)
- **本体** = 契约(出境单位) + 缓存计划(本地热路径,可弃) 【岔口C】
- **门** = 难硬化/易软化,双 deopt 触发器(契约违反+执行漂移)
- **生命周期** = 涌现软模式 → 晋升 → 硬化 → 偏离↑ → deopt 回软

三线索(硬化/联邦/群)共享同一可寻址对象;C 让「发往 2/3 的是契约不是程序」成为机械事实。

**下次动作**:硬化 skill 结构核心已收口,无新证据不起工(非待实现)。若再续——未深挖的支:① 晋升门 A 的机械定义(N 阈值/置信曲线)② 结构hash 粒度(整 skill vs 子模式)③ 群路由的匹配语义(契约同构 vs 偏序蕴含)。这些是 2/3 落地前沿,目前停在愿景层。

关联:[[project_capability_graph_adr51]] [[project_phase13_complete]] [[project_memex_terminal_naming]] [[feedback_reanchor_on_original_design_when_drifted]]
