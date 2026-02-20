# Investigation Notes - codex-runtime-server-owned-redesign

## Date

- 2026-02-20 (re-investigation pass)

## Goal

Restart investigation from first principles and validate whether framework architecture should be improved (especially explicit TURN lifecycle and SoC boundaries) before Codex app-server runtime implementation.

## Scope Triage

- Classification: `Large`
- Reason:
  - Runtime contract redesign across command ingress, websocket event transport, run-history identity, and approval callbacks.
  - Cross-project boundary impact (`autobyteus-ts`, `autobyteus-server-ts`, websocket/API clients, future frontend runtime selector behavior).
  - High regression risk if run-centric and turn-centric contracts remain mixed/implicit.

## Sources Consulted

### Ticket Artifacts

- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/tickets/in-progress/codex-runtime-server-owned-redesign/requirements.md`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/tickets/in-progress/codex-runtime-server-owned-redesign/proposed-design.md`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/tickets/in-progress/codex-runtime-server-owned-redesign/proposed-design-based-runtime-call-stack.md`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/tickets/in-progress/codex-runtime-server-owned-redesign/runtime-call-stack-review.md`

### Current Server/Core Implementation

- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-ts/src/agent/context/agent-runtime-state.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-ts/src/agent/input-processor/memory-ingest-input-processor.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-ts/src/agent/handlers/llm-user-message-ready-event-handler.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-ts/src/agent/handlers/tool-result-event-handler.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-ts/src/agent/streaming/events/stream-events.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-ts/src/agent/streaming/events/stream-event-payloads.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-ts/src/memory/memory-manager.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-ts/src/memory/turn-tracker.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/src/services/agent-streaming/models.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/src/services/agent-streaming/agent-stream-handler.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/src/services/agent-streaming/agent-team-stream-handler.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/src/services/agent-streaming/team-runtime-event-protocol.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/src/run-history/domain/models.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/src/run-history/services/run-history-service.ts`
- `/Users/normy/autobyteus_org/autobyteus-workspace/autobyteus-server-ts/docs/modules/codex_integration.md`

### Local Codex CLI Protocol Evidence (Regenerated This Pass)

- `codex --version` -> `codex-cli 0.104.0`
- `codex app-server generate-json-schema --out /tmp/codex-schema`
- `/tmp/codex-schema/v2/TurnStartParams.json`
- `/tmp/codex-schema/v2/TurnInterruptParams.json`
- `/tmp/codex-schema/v2/TurnStartedNotification.json`
- `/tmp/codex-schema/v2/TurnCompletedNotification.json`
- `/tmp/codex-schema/ServerRequest.json`
- `/tmp/codex-schema/ServerNotification.json`
- `/tmp/codex-schema/codex_app_server_protocol.schemas.json`

## Verified Facts (Current State)

1. TURN exists in core runtime, but mainly as internal context/memory correlation.
- `autobyteus-ts` maintains `activeTurnId` and starts turns in memory ingest + LLM user message handler.
- Tool flows propagate `turnId` and reject mismatched turn results.
- This is good internal consistency, but not yet a full server-facing lifecycle contract.

2. Server websocket protocol is still run/session-centric and does not model turn lifecycle explicitly.
- Client messages are `SEND_MESSAGE`, `STOP_GENERATION`, `APPROVE_TOOL`, `DENY_TOOL`.
- No explicit `TURN_STARTED` / `TURN_COMPLETED` / `TURN_INTERRUPTED` server protocol types.
- Unknown/unmapped runtime events are treated as generic errors.

3. Stop-generation remains non-functional in current implementation paths.
- Single-agent websocket handler logs stop request only.
- Team websocket handler logs stop request only.
- This conflicts with deterministic interrupt semantics required by Codex turn interrupt model.

4. Run manifest model currently lacks runtime-native thread/turn identity.
- `RunManifest` has no `runtimeKind`, `threadId`, `turnId`, `runtimeReference` fields in current server code.
- Proposed design mentions these, but they are not implemented.

5. Codex app-server protocol is explicitly thread/turn/item-first.
- `turn/start` requires `threadId` and input.
- `turn/interrupt` requires both `threadId` and `turnId`.
- Notifications and approval requests carry protocol-native IDs (`threadId`, `turnId`, `itemId`).

6. Approval callbacks are richer than current generic approve/deny shape.
- Server requests include `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`.
- Request params include correlation keys (`threadId`, `turnId`, `itemId`, and optional `approvalId` for callback disambiguation).
- Current ticket call stacks still frame this as simplified tokenized `approveTool(...)`.

## Design Gap Assessment (Re-investigation)

### Gap A: TURN contract is implicit in core but not explicit at server/runtime boundary

- Impact:
  - Makes Codex adapter translation fragile.
  - Makes interrupt correctness hard to guarantee.
  - Forces mappers/handlers to infer lifecycle from partial events.

### Gap B: Proposed design and call stacks are not aligned with updated requirements (UC-009..UC-012)

- Requirements include app-server bootstrap/thread-turn-item identity, but:
  - `proposed-design.md` use-case section still enumerates UC-001..UC-008.
  - `proposed-design-based-runtime-call-stack.md` is still `Medium` and covers UC-001..UC-008 only.
- This mismatch blocks safe implementation kickoff.

### Gap C: Interruption semantics are under-specified for Codex

- Codex requires `(threadId, turnId)` for interrupt.
- Current model/handler shape is primarily `runId`-centric.
- Without explicit run->thread/turn state contract, interruption may become best-effort and nondeterministic.

### Gap D: Event identity is not explicitly modeled as dual-key (server sequence + upstream protocol IDs)

- Server sequence (`eventId`, `sequence`) is useful for ordering/replay.
- Codex upstream IDs (`threadId`, `turnId`, `itemId`) are required for audit and callback correlation.
- Both must be first-class in one canonical envelope, not split across ad hoc payload fields.

### Gap E: Separation of concerns is directionally good but still mixes translation responsibilities

- Current design strongly improves stream orchestration (`orchestrator`, `subscriber hub`, `catchup`), which is good.
- But protocol translation concerns (thread/turn/item lifecycle + callback routing) are not yet isolated as their own contract modules.

## Framework Improvement Direction (Recommended)

### 1) Make TURN explicit as a platform contract, not just memory metadata

Add explicit server-domain lifecycle models (runtime-agnostic):

- `RuntimeConversationRef`
  - `runId`, `runtimeKind`, `threadId?`, `activeTurnId?`
- `RuntimeTurnLifecycle`
  - `turnId`, `threadId`, `status` (`in_progress` | `completed` | `interrupted` | `failed`), timestamps
- `RuntimeItemLifecycle`
  - `itemId`, `turnId`, `threadId`, `itemType`, `status`, timestamps

This lets Autobyteus runtime and Codex runtime share one explicit lifecycle abstraction.

### 2) Split runtime adapter responsibilities into clear sub-boundaries

Inside `codex-app-server-runtime-adapter`, separate concerns explicitly:

- `codex-thread-turn-gateway`
  - `thread/start|resume|read`, `turn/start|interrupt`
- `codex-approval-callback-router`
  - maps `item/.../requestApproval` and `item/tool/requestUserInput` to ingress decisions
- `codex-event-translator`
  - protocol notifications -> normalized runtime event envelope

This avoids one oversized adapter class and improves testability.

### 3) Upgrade runtime command ingress contracts to be lifecycle-aware

- `sendTurn(...)` returns at least `threadId` + `turnId` correlation metadata.
- `interruptRun(...)` contract accepts optional explicit target (`threadId`, `turnId`) and resolves deterministically for runtime kinds requiring it.
- Approval APIs should route by callback identity (`approvalId` when present, else item correlation tuple).

### 4) Standardize event envelope as dual identity by default

Every normalized runtime event should carry:

- Server identity: `eventId`, `sequence`, `occurredAt`, `runId`
- Upstream correlation (nullable but explicit): `threadId`, `turnId`, `itemId`, `approvalId`
- Event taxonomy: `lifecycleDomain` (`thread` | `turn` | `item` | `tool` | `status` | `artifact`), `eventType`

Persistence and websocket mapping must consume the same envelope instance.

### 5) Preserve existing architecture by introducing translation layer, not mutating core agent contracts

- Keep `autobyteus-ts` internal turn behavior unchanged.
- Introduce runtime translation/mapping at server boundary.
- For non-Codex runtime, synthesize optional protocol fields (or leave nullable) through the same envelope path.

This is the safest path to avoid breaking existing behavior while improving architecture.

## Safety / Regression Strategy

1. Keep one runtime command ingress interface, but runtime-specific adapter implementations.
2. Add golden tests for Codex protocol translation (turn start/completed/interrupted, item started/completed, approval callbacks).
3. Add invariant tests that existing local runtime behavior remains unchanged when protocol fields are null/synthesized.
4. Add reconnect tests proving no event loss across replay + live cutover with turn/item metadata preserved.
5. Add stop-generation integration tests for single-agent and team websocket paths.

## Re-investigation Conclusion

- Decision: `No-Go` for implementation start until design/call-stack artifacts are rewritten to include explicit thread/turn/item contracts and callback correlation.
- Positive assessment: current framework foundations are good enough to improve safely without breaking existing system, if translation boundaries are made explicit and contracts are normalized at the server runtime layer.

## Required Write-Backs After This Investigation

1. Update `proposed-design.md` to include UC-009..UC-012 as first-class sections with explicit adapter translation contracts.
2. Regenerate `proposed-design-based-runtime-call-stack.md` as `Large` scope and include lifecycle/callback use cases.
3. Re-run `runtime-call-stack-review.md` with two consecutive clean deep-review rounds before opening gate.
4. Add explicit contract checklist for:
   - turn interrupt correlation,
   - item approval callback routing,
   - dual identity envelope parity (websocket + persistence),
   - no-op stop-generation removal for both agent and team paths.

## Open Unknowns

- Minimum supported Codex app-server method surface in v1 (full thread lifecycle vs constrained subset).
- Whether team ingress should keep tokenized decision mapping or move to explicit callback-id keyed routing end-to-end.
- Storage retention/index strategy for high-volume item delta events with queryable turn/item replay windows.
