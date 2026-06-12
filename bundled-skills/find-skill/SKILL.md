---
name: find-skill
description: Search for and install agent skills when a task needs a capability you do not have. Use when you lack a skill for the current task, when the user asks to find or install a skill, or before writing custom code for a common problem someone has likely already packaged.
---

# Find Skill

When a task needs a capability you don't have, search the skill registries
before writing it from scratch.

## Steps

1. Search both registries:

   ```
   memex skills search <task keywords>
   ```

   Results show `[registry] id — name: description`. Pick by description fit,
   not name similarity.

2. Install the best match:

   ```
   memex skills install <registry> <id> [name]
   ```

   The install runs a guard scan first. If findings are reported, READ THEM —
   do not blindly re-run with `--yes-despite-findings`. Report findings to the
   user and let them decide.

3. Verify: `memex skills inspect <name>` re-scans the installed skill.

## Rules

- Never install a skill with guard findings without explicit user approval.
- Prefer skills with specific, keyword-rich descriptions over vague ones.
- If no skill fits, say so — falling back to writing the logic yourself is
  better than installing a poor match.
