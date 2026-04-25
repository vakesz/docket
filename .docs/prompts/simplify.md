# Review this Python codebase and produce a simplification plan

## Goal

Identify the highest-value opportunities to simplify the codebase **and improve its long-term maintainability** without changing intended behavior.

Favor:

- simpler code
- fewer abstractions
- less duplication
- more idiomatic Python 3.12
- stdlib / Pydantic / Typer / Textual / FastAPI built-ins over bespoke helpers
- lower cognitive load — code that reads linearly and localizes each reason-to-change
- consistent patterns so the next reader can predict structure across modules
- changes that make the next maintainer's job easier six months out, not just today's diff smaller

This is a simplification and maintainability pass. Route deeper structural or boundary concerns (layer violations, ownership, concurrency) to a 🔵 SUGG and defer the larger work.

## What to look for

### Abstractions and indirection

- wrappers that forward to a single call
- service methods that pass straight through to a repo with no added logic
- protocols / ABCs with one implementer and no test-seam benefit
- context objects carrying fields only one caller uses

### Duplication

- repeated mutation-pipeline boilerplate across `cli/commands/`, `api/routes/mutations.py`, and `agent/mutating_tools.py`
- parallel onboarding / setup logic across `cli/`, `api/routes/setup.py`, and `config/`
- similar list / show adapters in `cli/commands/` and `api/routes/`
- hand-rolled helpers where stdlib / Pydantic / Typer / FastAPI already covers it

### Idiomatic Python

- classes where a function suffices
- `Optional` chains where an early return is clearer
- loops that `itertools`, `functools`, or comprehensions replace cleanly
- dispatch dicts of callables where `match` / `enum` is clearer
- `datetime` arithmetic `timedelta` / `zoneinfo` already handles
- broad `except Exception` that swallows real errors

### Dead and redundant code

- unused imports, unused params, unreachable branches
- compatibility shims (project is solo, main-only, no backward-compat)
- comments restating what the code says
- `_v1` / `_v2` suffixes, commented-out blocks, leftover TODOs

### Types and safety

- `Any` / untyped returns where mypy strict would accept a real type
- `assert` used for runtime validation
- silent fallbacks that mask misconfiguration
- missing `conn` / `provider` threading leading to connections opened inline

### Access control and naming

- module-public names with only intra-module callers — rename to `_private`
- names describing implementation (`Manager`, `Helper`, `Util`) instead of role
- names that no longer match responsibility after drift — flag; rename only when low-risk

### Long-term maintainability

- files or classes doing more than one thing — split along the natural seam
- magic numbers and string literals repeated across modules — lift to a single constant or config accessor
- configuration read in multiple places with subtly different fallbacks — consolidate to one accessor
- tests coupled to private implementation instead of observable behavior — rewrite toward fakes and pilot-style assertions (per CLAUDE.md testing guidance)
- error messages that do not identify which component failed, or swallow the original cause — preserve `raise ... from err` chains
- modules that re-export symbols for convenience but blur the import boundary — prefer direct imports from canonical homes
- ad-hoc patterns that diverge from an already-established one nearby — align with the existing pattern unless the divergence is intentional
- comments explaining *what* instead of *why* — replace with a clearer name, or keep only the non-obvious *why* (hidden constraint, subtle invariant, specific bug workaround)

## Preserve intentionally

Load-bearing by design. Do not propose changes that alter:

- the provider import boundary (`core/`, `storage/`, `agent/`, `api/` must not import concrete providers)
- the proposal-first mutation pipeline (`mutation_service.propose_* → confirm`)
- canonical enums at the boundary (`ItemKind`, `ItemState`, `TransitionIntent`)
- byte-stable prompt prefix (`agent/prompt.py`) and tool registration order (`agent/tools.py`)
- SQLite-as-cache with refresh-after-write invariant
- explicit context threading (`conn`, `provider`, `paths`, `config`) — no hidden globals
- read-only mode guards on every mutation entry point and the stripping of mutating agent tools
- watchlist row independence from `items(id)`
- prompt hot reload, conversation compaction, external update injection, bootstrap app split
- anything else in CLAUDE.md's "Non-Negotiable Rules" or "Global Invariants"
- architectural tests: `tests/unit/test_import_boundary.py`, `tests/unit/test_state_map_reverse.py`, `tests/unit/test_tool_registration_order.py`, `tests/integration/test_github_stub_provider.py`, `tests/integration/test_cli_read_only.py`, `tests/integration/test_api_read_only.py`, `tests/pilot/test_read_only_mode.py`, `tests/integration/test_prompt_loader.py`

## Safety rules

- Before removing, renaming, inlining, or consolidating, check every call site with `rg`.
- If a symbol's purpose is unclear, mark it **needs clarification** and move on.
- Prefer reshaping toward the documented flow over inventing a new abstraction.
- Standing test: *would a typical Python / FastAPI / Typer / Textual developer write it this way?*
- No opportunistic reformatting — every changed line must trace to a listed finding.

## Output format

Plan grouped by priority. Under each priority, sub-group findings by the **What to look for** category they map to.

### High-value, low-risk

Clear complexity reduction with minimal behavioral risk and small blast radius. Eligible for aggressive execution under the workflow below.

### Medium-value or moderate-risk

Meaningful simplification but touches multiple call sites or crosses module boundaries. Requires explicit user go-ahead before applying.

### Strategic / high-risk

Larger shifts (collapsing a service layer, merging route modules, overhauling setup). Name them for the record; do not apply in the same pass. Include a one-line "why not now" note.

### Needs clarification

Ambiguous intent, docs-vs-code disagreement, or dependent on project direction. Ask.

For each finding:

- **Affected file(s)** — absolute-from-repo paths with line numbers
- **Category** — which "What to look for" bucket it belongs to
- **Current shape** — one or two sentences
- **Proposed shape** — what should change, which idiom / primitive to align with
- **Why** — the simplification benefit
- **Blast radius** — files / call sites / tests likely to move
- **Risk** — low / medium / high
- **Verification** — which `uv run` commands to re-run, plus any manual checks
- **Touches a non-negotiable?** — if so, stop and escalate instead of proposing

Top-level sections:

- **Do not touch** — items reviewed and deliberately left alone, one-line reason each
- **Conflicts between docs and code** — flag only; do not resolve
- **Flagged issues** inline:
  - 🔴 BUG — correctness, data loss, or invariant-break risk
  - 🟡 WARN — smell likely to cause future bugs or drift
  - 🔵 SUGG — opportunity, no immediate risk

## Execution workflow (aggressive cleanup mode)

When the user has authorized aggressive cleanup for this session, execute the plan in batches under strict verification gates. Otherwise stop after the plan.

1. **Baseline.** Run `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy src`, and `uv run pytest`; capture logs under `.agent-logs/simplify-baseline-<YYYYMMDD>.log` via `tee`. If any are red, fix or flag before starting — do not layer simplifications onto a broken baseline.
2. **Batch** high-value, low-risk findings into small, related groups (5–10 changes, or one logical seam). Each batch must be independently shippable and revertible.
3. **For each batch:**
   - List the findings being applied with paths and line references.
   - Apply changes surgically. Every changed line traces to a listed finding. No drive-by reformatting.
   - Run `uv run ruff check .` → `uv run ruff format --check .` → `uv run mypy src` → `uv run pytest`, piping each through `tee` into `.agent-logs/simplify-batch<N>-<step>-<YYYYMMDD>.log`.
   - If a gate fails, stop, diagnose root cause, and fix. Do not bypass hooks or skip checks. If the fix balloons past the batch, revert and re-plan.
   - After all gates pass, summarize: what changed, verification results, remaining blast radius.
4. **Medium-value batches** only after explicit user go-ahead, even in aggressive mode. Same gate discipline.
5. **Never touch** anything in "Preserve intentionally" or "Do not touch". Aggressive mode is not a license to rewrite load-bearing code.
6. **Stop conditions.** Halt and report back if:
   - a gate fails twice on the same batch,
   - a proposed change reveals a strategic / high-risk shift once begun,
   - a finding surfaces a 🔴 BUG outside the cleanup scope,
   - the plan runs out of high-value, low-risk items.
7. **Final pass.** On session end, produce a short changelog: batches applied, batches deferred, remaining findings by priority.

Destructive or cross-boundary actions (removing modules with external callers, changing schema versions or persistence keys, renaming public types) still require explicit confirmation regardless of mode.
