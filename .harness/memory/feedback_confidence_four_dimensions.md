---
name: feedback_confidence_four_dimensions
description: "全局置信度框架——每个判断由4维构成,按同时肯定的维度数定档(4=high/3=medium/2=low/1=no)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ac88af5b-88f3-4a66-9a09-2a2a82a0784a
---

全局规则：任何判断都由 4 个维度构成——① 用户做出的判断 ② 模型自主推导的判断 ③ 已成熟的可参考逻辑/代码/算法 ④ 用 websearch 或 tools 经 research 得到的判断。

置信度按**同时肯定某件事的维度数**定档：
- 4/4 → high confidence (0.9–1)
- 3/4 → medium confidence (0.6–0.9)
- 2/4 → low confidence (0.3–0.6)
- 1/4 → no confidence (0–0.3)

**决策-行动映射**（当我自主决策或独立工作时，由档位决定行动权限）：
- **high** → 直接自动执行。
- **medium** → 也可自动执行，但完成后必须让用户知道做了哪些决策（act-then-notify）。
- **low** → 必须先问用户。注意升档机制：① 加上"用户做出的判断"这一维后 low→medium（用户拍板即解锁执行）；② 若用户已拍板但仍是 low，则用 research 工具补信源把第④维补足再升档。
- **no** → 不擅自行动，继续与用户讨论直到至少有第二个维度肯定。

**Why:** 用户要求把"判断有多可信"显式化、可审计，避免我用语气/自信冒充证据（呼应 CLAUDE.md §5 Harness Discipline：confidence is not a source）。映射把置信度直接绑到"能不能自己动手"，medium 的 act-then-notify 是效率与可控的平衡点。

**How to apply:** 给出关键判断时标注档位，并点明是哪几个维度在支撑——让用户一眼看出是"四维共振"还是"仅模型单方推导"。按映射决定行动：medium 自动做但回报、low 先问、no 不动。低档位要主动暴露缺哪个维度、需要补什么（research 或等用户拍板）才能升档。
