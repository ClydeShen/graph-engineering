# Git commit conventions (enforced by hooks)

This repo uses husky (`core.hooksPath=.husky/_`) for git hooks. Both hooks are
active for every commit — do not bypass them with `--no-verify` unless the
user explicitly asks.

## Commit message format

`commit-msg` runs commitlint with `@commitlint/config-conventional`. Subject
line must be:

```
<type>(<scope>)?: <description>
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, `revert`. Scope is optional, free-form (matches
existing history, e.g. `feat(channels+providers): ...`, `fix(cli): ...`).

## Large-file guard

`pre-commit` checks staged file sizes:
- `>= 50MB` — commit is **blocked**. Add the path to `.gitignore` instead of
  committing it (this is how the `.next/cache` 128MB incident happened).
- `>= 5MB` — warning only, commit proceeds.

If a commit is blocked for this reason, do not work around it by force-adding
or disabling the hook — fix `.gitignore` and unstage the offending file with
`git restore --staged <file>`.
