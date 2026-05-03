# Simplify Codebase — Re-runnable Audit & Cleanup Prompt

Paste this entire file into a fresh Claude Code session. It is designed to be
re-run as many times as you like — each run starts with a fresh audit of the
current tree, so prior runs can't "stale-bias" the next one.

---

## Re-run rules (read first)

- **Always start from scratch.** Do not rely on memory, prior plans, or notes
  from a previous run. Re-audit the live codebase. The repo is the source of
  truth; everything else is stale.
- **No persisted state in the prompt.** This file does not track progress.
  If a finding from a prior run is already fixed, it simply won't appear in
  this run's audit — that's the intended behavior.
- **Idempotent execution.** If a batch's edits would be a no-op (already
  applied), report "already clean" and skip. Never re-delete, re-rename, or
  re-format something that is already in the desired shape.
- **No scratch files.** Do not create plan/audit/findings markdown files in
  the repo. Findings live in the chat for the current run only.
- **Commits are the durable artifact.** Each run may produce 0..N commits on
  `main`. If a run produces nothing, that's success — the codebase was
  already clean by this prompt's standards.

---

## Mission

Audit the Docket codebase for unnecessary complexity, code smells, and
deviations from modern TypeScript / Next.js App Router / React best practices.
Then aggressively simplify — but inside a tight set of rails.

**ULTRATHINK before acting. Plan first, execute second.**

---

## Skills to use (in this order)

1. `nextjs-app-router-patterns` — RSC vs client boundary discipline, data
   fetching colocation, streaming, parallel/intercepting routes, caching
   semantics, Server Actions vs tRPC.
2. `typescript-expert` — strictness, branded IDs, discriminated unions,
   exhaustive narrowing, `satisfies`, generic constraints, `Result`-shaped
   errors, dead-type pruning.
3. `vercel-react-best-practices` — composition over prop drilling, Suspense
   boundaries, `useTransition` / `useDeferredValue` / `useOptimistic` /
   `useFormStatus` where they earn their keep.

For every finding, tag it with which skill flagged it.

---

## Hard invariants — DO NOT VIOLATE while simplifying

Read `CLAUDE.md` first. Simplification must preserve:

- **Provider agnosticism.** Routers go through `getProviderSpec` +
  `buildProviderForUser`. Never import `@/providers/<name>/*` from routers,
  services, UI, or core. If you find a leak — fix it; don't inline it as
  "simplification."
- **LLM agnosticism.** Vendor SDKs (`openai`, Anthropic, etc.) live only in
  `src/agent/llm/**` and `src/agent/guardrail/llm-judge.ts`. Everything else
  talks to `LlmAdapter`.
- **Proposal-first writes.** `confirmProposal` is the sole caller of provider
  write methods. Don't "simplify" by short-circuiting it.
- **Audit append-only.** `insert/update/delete(audits)` only from
  `proposals/executor.ts` + `server/audit/log.ts`.
- **Prompt prefix byte-stability** + **agent tool registration order**
  (`TOOL_ORDER` in `src/agent/tools/registry.ts`). Reordering = cache bust.
  Don't.
- **Architecture tests in `src/__arch__/` are not negotiable.** They must
  pass after every change. If a test gets in your way, the leak is the bug,
  not the test.
- **React Compiler is on** (`reactCompiler: true`). Do NOT add `useMemo` /
  `useCallback` / `React.memo`. If you find existing ones added defensively,
  remove them.
- **Drizzle is the only ORM.** Canonical imports: `@/db`, `@/db/schema`,
  `@/db/schema/types`. No raw whole-query SQL outside `src/db/` and the
  existing allowlist.

---

## Solo-project context

- Single maintainer, main branch only, unreleased.
- Schema is v1 — no migration backward-compat dance.
- **Delete legacy scaffolding outright.** No deprecation comments, no
  re-exports, no `_unused` shims, no "kept for compat" branches.
- Default to no comments. Only keep ones that capture a non-obvious WHY
  (hidden constraint, subtle invariant, specific-bug workaround).

---

## What "aggressive simplification" means here

YES, hunt for:

- Premature abstractions (single-call-site helpers, generics with one
  concrete instantiation, factories returning one shape).
- Indirection without payoff (wrapper functions that just rename args, thin
  service layers that pass through to a single Drizzle call).
- Defensive code for impossible states (validation at internal boundaries,
  fallbacks for branches the type system already excludes, try/catch that
  swallows then re-throws).
- Dead code: unreachable branches, unused exports, types that are never
  narrowed, parameters that are always the same value.
- Duplicated logic that should be one helper (and confirm it earns being a
  helper — three near-identical lines is fine).
- Manual memoization, manual ref juggling, effect-heavy components that
  should be event handlers or server components.
- `any`, unjustified `as`, `// @ts-expect-error` without a reason, `unknown`
  left un-narrowed.
- Client components that could be server components (look for unnecessary
  `"use client"` at the top of files that don't need it).
- Waterfall data fetches that should be parallelized or streamed.
- Over-broad `revalidatePath` / cache invalidation.
- Prop drilling that composition (children-as-slots) would erase.
- Fat barrels that hurt tree-shaking.

NO, do not:

- "Simplify" by collapsing an arch boundary (provider, LLM, proposal, audit).
  Those exist for a reason.
- Reduce test coverage. Arch tests stay green; unit tests stay green.
- Inline branded ID minting at internal call sites.
- Touch `globals.css` (it is paste-only tweakcn output).
- Reorder tool registration or change prompt-prefix bytes.

---

## Methodology

### Phase 1 — Audit (read-only)

Walk the tree with the three skills' lenses. Produce a single ranked findings
list **in chat**. Each finding:

- File + line range.
- Category (premature abstraction / dead code / RSC boundary / etc.).
- Skill that flagged it.
- Severity (sev1 = clear win, sev2 = judgment call, sev3 = nice-to-have).
- Proposed change in one sentence.
- Risk: what could break, which arch test covers it.

Group findings by area: `src/app/`, `src/ui/`, `src/server/`, `src/agent/`,
`src/providers/`, `src/db/`, `src/core/`, `bin/`, tests.

If the audit produces zero findings, say so explicitly and stop. That is a
valid outcome of a re-run.

### Phase 2 — Plan

Stop. Show me the findings list before writing code. Group into batches that
can ship as logical commits. For each batch state:

- What changes.
- Why it's safe (which invariants and tests cover it).
- Whether it's mechanical or needs judgment.

Wait for my go-ahead, or for me to prune the list, before Phase 3.

### Phase 3 — Execute

Per batch:

1. Make the edits.
2. Run `pnpm check` (biome + tsc + vitest) — must be green.
3. Run `pnpm test src/__arch__/` explicitly — must be green.
4. If anything UI-facing changed, say so explicitly and note that you could
   not browser-test it.
5. Stage one logical commit per batch with a tight message. **No
   `Co-Authored-By` trailer.** Don't push.

If a batch fails checks, stop and report — don't paper over it. If a batch
turns out to be a no-op against the current tree (already simplified by a
prior run), skip it cleanly and move on.

---

## Output expectations

- Phase 1 deliverable: findings list, in chat, no edits yet.
- Phase 2 deliverable: batched plan, in chat, no edits yet.
- Phase 3 deliverable: commits on `main`, with a short summary of what
  shipped and what was deferred. Zero commits is a valid result.

Be terse. State results, not deliberation. End each phase with a clear
"ready for next phase?" handoff.
