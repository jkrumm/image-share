# apps/admin

Repo-wide stack, commands and rules: the root `AGENTS.md`.

## Design system — agent pointer

Read `DESIGN.md` (this directory) before any UI work — it is the app-delta record and the
highest-precedence design law. The basalt-ui doctrine lives in `.claude/rules/basalt-*.md` (six
rules, all law) and the framework-managed block in `CLAUDE.md` (written by `basalt-ui sync`; it
stays there because the sync tool hard-codes that host file, and `sync --check` gates it in CI).
Precedence: `DESIGN.md` > the `basalt-*` rules > the `basalt-*` skills.
