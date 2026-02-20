# Investigation Notes

## Stage

- Understanding Pass: `Completed`
- Last Updated: `2026-02-20`

## Sources Consulted

- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/tickets/in-progress/persistence-provider-file-mode/proposed-design.md`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/tickets/in-progress/persistence-provider-file-mode/future-state-runtime-call-stack.md`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/tickets/in-progress/persistence-provider-file-mode/future-state-runtime-call-stack-review.md`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/src/app.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/src/startup/migrations.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/package.json`
- `rg -n "from \"@prisma/client\"" src`

## Key Findings

1. Ticket location/state
- The ticket already exists at `tickets/in-progress/persistence-provider-file-mode`, so no move was required.

2. Workflow artifact completeness
- Existing artifacts: `proposed-design.md`, `future-state-runtime-call-stack.md`, `future-state-runtime-call-stack-review.md`.
- Missing mandatory workflow artifacts: `investigation-notes.md` and `requirements.md`.

3. Current code baseline
- Startup still runs migrations unconditionally via `src/app.ts:startServer()` -> `runMigrations()`.
- `src/startup/migrations.ts` is Prisma-specific and contains Prisma error recovery paths.
- SQL repositories/providers across active persisted domains still import `@prisma/client`.

4. Deep review finding impacting Android/edge objective
- Existing ticket design covered Prisma-free compile graph (`build:file`) but did not fully specify a Prisma-free install/runtime dependency profile.
- `package.json` currently has hard dependencies on `repository_prisma` and `@prisma/client`.
- For Android/edge deployment, compile-only decoupling is insufficient unless packaging/runtime dependency behavior is also explicitly defined and verified.

5. Deep review finding impacting use-case sufficiency
- Existing use-case set was file-profile heavy and did not explicitly model SQL-profile startup/provider regression path.
- Because requirements already preserve SQL profiles, missing explicit SQL regression use case weakens call-stack completeness for profile-selection behavior.

## Constraints

- Must preserve SQL profiles (`sqlite`/`postgresql`) when selected.
- Must not retain legacy compatibility branches in the new architecture.
- Must support deployment scenarios where Prisma binary/toolchain is not available.

## Open Questions

1. Packaging approach for file profile
- Should file profile artifacts use a dedicated package manifest (no Prisma deps), or keep one manifest with optional dependencies and profile-aware install/build scripts?

2. Runtime guard behavior
- Should startup fail fast with explicit guidance when `PERSISTENCE_PROVIDER=file` is selected but SQL-only dependencies are accidentally present/required?

3. CI matrix scope
- What is the minimum required CI gate to treat file profile as deployable to Android/edge (compile, startup smoke, selected API smoke)?

## Implications For Requirements/Design

- Requirements must include explicit acceptance criteria for Prisma-free install/startup in file profile, not just Prisma-free compilation.
- Design/use cases must add a packaging/install use case and trace it to runtime-call-stack and review gate.
- Requirements/design/runtime-call-stack should include one explicit SQL-profile regression guard use case.
- Review gate must enforce two consecutive clean rounds after the last write-back before declaring `Go Confirmed`.
