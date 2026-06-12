---
name: create-skill
description: Author a new agent skill as an agentskills.io-compliant SKILL.md package. Use when the user wants to package a workflow, instructions, or domain knowledge as a reusable skill, or asks to create, write, or export a skill.
---

# Create Skill

Skills are directories with a SKILL.md (YAML frontmatter + Markdown body).
Follow the agentskills.io specification exactly — validators reject deviations.

## Frontmatter rules

```markdown
---
name: skill-name
description: What it does and when to use it.
---
```

- `name`: 1-64 chars, lowercase letters/numbers/hyphens only, no leading or
  trailing hyphen, no consecutive hyphens, MUST match the directory name.
- `description`: 1-1024 chars. State both WHAT the skill does and WHEN to use
  it, with concrete trigger keywords — this is how agents decide to load it.
- Optional: `license`, `compatibility` (env requirements), `metadata` (map),
  `allowed-tools` (space-separated pre-approved tools; experimental).

## Body guidelines

- Keep SKILL.md under 500 lines; under 5000 tokens loads when triggered.
- Step-by-step instructions, example inputs/outputs, edge cases.
- Split detail into `references/*.md` (loaded on demand), executable helpers
  into `scripts/` — progressive disclosure keeps token cost down.
- Reference bundled files by relative path, one level deep.

## Export

`memex skills` can export to agentskills.io / ClawHub — both share this
frontmatter schema, so one SKILL.md publishes to either registry.
