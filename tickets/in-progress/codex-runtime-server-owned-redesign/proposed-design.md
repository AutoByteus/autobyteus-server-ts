# Proposed Design Document

## Design Version

- Current Version: `v19`

## Revision History

| Version | Trigger | Summary Of Changes | Related Review Round |
| --- | --- | --- | --- |
| v18 | Prior stabilization | Reconnect cleanup, sequence, subscriber/orchestrator boundaries stabilized for UC-001..UC-008. | 32 |
| v19 | Re-investigation write-back | Added explicit Codex thread/turn/item lifecycle contracts, callback-routing contracts, dual-identity envelope fields, and expanded use-case coverage to UC-001..UC-012. | 34 |

## Summary

Introduce a server-owned runtime adapter layer so runtime selection and Codex integration stay in `autobyteus-server-ts`, while `autobyteus-ts` core remains unchanged. This revision makes TURN lifecycle and protocol correlation explicit at server boundaries.

## Scope Classification

- Classification: `Large`

## Goals

- Keep `autobyteus-ts` core invariants strict (no nullable-core redesign).
- Add runtime selection via server composition (`autobyteus` / `codex_app_server`).
- Add explicit runtime command ingress for send/interrupt/approval calls.
- Add explicit runtime lifecycle contracts for `thread`, `turn`, and `item`.
- Add explicit callback routing contracts for Codex app-server approval methods.
- Add deterministic runtime-event envelope identity for websocket delivery and run-history parity.
- Preserve upstream protocol correlation IDs (`threadId`, `turnId`, `itemId`, `approvalId?`) alongside server sequence identity.
- Keep reconnect replay/live handoff gap-free and deterministic under multi-session subscriptions.

## Non-Goals

- Changing `autobyteus-ts` `AgentConfig` invariants.
- Building frontend runtime selector UX in this ticket.
- Supporting mixed-runtime execution inside one run.

## Legacy Removal Policy (Mandatory)

- Policy: `No backward compatibility; remove legacy code paths.`
- Required removals:
  - remove no-op `STOP_GENERATION` behavior in single-agent and team websocket handlers,
  - remove direct runtime-path `LlmModelService` usage from GraphQL/startup paths.

## Requirements And Use Cases

- `UC-001`: Create run with runtime kind selection.
- `UC-002`: Send turn on active run via command ingress.
- `UC-003`: Continue inactive run via migrated runtime reference.
- `UC-004`: Stop generation via deterministic runtime interrupt.
- `UC-005`: Handle approval/denial decisions via runtime ingress.
- `UC-006`: Normalize runtime events with deterministic envelope identity and pre-connect policy.
- `UC-007`: Runtime-scoped model listing/reload/preload.
- `UC-008`: Runtime transport/session failure handling.
- `UC-009`: Initialize Codex app-server session/thread context.
- `UC-010`: Map Codex thread/turn/item lifecycle to run/session state.
- `UC-011`: Preserve upstream protocol IDs with server sequence identity.
- `UC-012`: Reconnect catch-up and live handoff without gaps.

## Current State (As-Is)

- Run creation/restoration is local-runtime-centric.
- Turn exists internally in core memory/runtime context but is not explicit at server/runtime contract boundary.
- `STOP_GENERATION` remains no-op in websocket handlers.
- Stream message protocol does not explicitly model turn lifecycle states.
- Run manifest model does not persist runtime-native thread/turn correlation identity.

## Target State (To-Be)

- `RuntimeCompositionService` selects/configures runtime adapter per run.
- `RuntimeCommandIngressService` is canonical entrypoint for send/interrupt/approval operations.
- `RuntimeSessionStore` + `RuntimeCorrelationStateStore` persist run -> runtime + thread/turn correlation state.
- `CodexThreadTurnGateway` owns Codex `thread/*` and `turn/*` request semantics.
- `CodexApprovalCallbackRouter` owns callback request/decision correlation for command/file/tool-input flows.
- `CodexEventTranslator` converts app-server notifications to canonical runtime events with lifecycle domain.
- `RuntimeEventEnvelopeNormalizer` emits one envelope containing both server sequence identity and upstream correlation IDs.
- Run-history persists the same normalized envelope used for websocket mapping.

## Change Inventory (Delta)

### Baseline Carried Forward

- `C-001..C-047` from `v18` remain in scope and unchanged as foundational runtime orchestration and reconnect hardening.

### New / Refined Changes in `v19`

| Change ID | Change Type | Current Path | Target Path | Rationale | Impacted Areas |
| --- | --- | --- | --- | --- | --- |
| C-048 | Add | N/A | `src/runtime-execution/runtime-lifecycle-contracts.ts` | Canonical runtime-agnostic models for thread/turn/item lifecycle states. | runtime-execution, streaming, run-history |
| C-049 | Add | N/A | `src/runtime-execution/runtime-correlation-state-store.ts` | Persist run-scoped runtime correlation (`threadId`, latest `turnId`, callback mappings). | runtime-execution, streaming |
| C-050 | Add | N/A | `src/runtime-execution/adapters/codex/codex-thread-turn-gateway.ts` | Isolate Codex `thread/*` + `turn/*` request semantics from adapter orchestration. | codex adapter |
| C-051 | Add | N/A | `src/runtime-execution/adapters/codex/codex-approval-callback-router.ts` | Route callback methods and decision responses by (`approvalId?`, `itemId`, `threadId`, `turnId`). | codex adapter, ingress |
| C-052 | Add | N/A | `src/runtime-execution/adapters/codex/codex-event-translator.ts` | Translate app-server notifications (`turn/*`, `item/*`) into canonical runtime events with lifecycle domain. | codex adapter, streaming |
| C-053 | Modify | `src/runtime-execution/adapters/codex-app-server-runtime-adapter.ts` | same | Delegate to gateway/router/translator and remove mixed concerns. | codex adapter |
| C-054 | Modify | `src/services/agent-streaming/runtime-event-envelope-normalizer.ts` | same | Add first-class upstream correlation fields (`threadId`, `turnId`, `itemId`, `approvalId`). | streaming, run-history |
| C-055 | Modify | `src/services/agent-streaming/runtime-event-message-mapper.ts` | same | Add lifecycle-aware mapping for `thread`, `turn`, `item` domain events to websocket payload schema. | streaming |
| C-056 | Modify | `src/run-history/domain/models.ts` + `src/run-history/services/run-history-service.ts` | same | Store/query normalized envelopes with dual identity fields for replay/audit parity. | run-history |

## Protocol Translation Contracts (Codex App Server)

| Protocol Surface | Canonical Owner | Canonical Internal API | Output Contract |
| --- | --- | --- | --- |
| `thread/start`, `thread/resume`, `thread/read` | `codex-thread-turn-gateway.ts` | `startThread`, `resumeThread`, `readThread` | `RuntimeConversationRef` update + runtime session correlation state |
| `turn/start` | `codex-thread-turn-gateway.ts` | `startTurn` | `RuntimeTurnLifecycle` (`in_progress`) + correlation update |
| `turn/interrupt` | `codex-thread-turn-gateway.ts` | `interruptTurn({ threadId, turnId })` | deterministic interrupt outcome (`interrupted`/`not_found`) |
| `turn/started`, `turn/completed`, `turn/plan/updated`, `turn/diff/updated` | `codex-event-translator.ts` | `translateTurnNotification` | canonical runtime event with lifecycleDomain=`turn` |
| `item/started`, `item/completed`, `item/*/delta` | `codex-event-translator.ts` | `translateItemNotification` | canonical runtime event with lifecycleDomain=`item` |
| `item/commandExecution/requestApproval` | `codex-approval-callback-router.ts` | `registerCommandApprovalRequest` | callback token + correlation mapping + ingress request payload |
| `item/fileChange/requestApproval` | `codex-approval-callback-router.ts` | `registerFileApprovalRequest` | callback token + correlation mapping + ingress request payload |
| `item/tool/requestUserInput` | `codex-approval-callback-router.ts` | `registerToolInputRequest` | callback token + correlation mapping + ingress request payload |
| callback decision response | `runtime-command-ingress-service.ts` -> `codex-approval-callback-router.ts` | `resolveCallbackDecision` | protocol-correct callback response with deterministic idempotency |

## Architecture Overview

- API/WS input -> `RuntimeCompositionService` + `RuntimeCommandIngressService`.
- Runtime adapters emit runtime-native events.
- Codex adapter delegates protocol-specific concerns to:
  - `CodexThreadTurnGateway`,
  - `CodexApprovalCallbackRouter`,
  - `CodexEventTranslator`.
- Runtime stream worker orchestration and subscriber fanout remain split (`RuntimeRunStreamOrchestrator` and `RuntimeEventSubscriberHub`).
- `RuntimeEventEnvelopeNormalizer` produces canonical dual-identity envelope.
- Run-history persists normalized envelope first; websocket mapping occurs after persistence.
- Reconnect path remains replay-before-activate with replay watermark and pending-buffer drain.

## File And Module Breakdown

| File/Module | Change Type | Concern / Responsibility | Public APIs |
| --- | --- | --- | --- |
| `src/runtime-execution/runtime-composition-service.ts` | Existing (Modify) | Runtime selection and create/restore orchestration. | `createRun`, `restoreRun` |
| `src/runtime-execution/runtime-command-ingress-service.ts` | Existing (Modify) | Canonical send/interrupt/approval ingress. | `sendTurn`, `interruptRun`, `approveDecision` |
| `src/runtime-execution/runtime-lifecycle-contracts.ts` | Add | Runtime-agnostic lifecycle DTOs for thread/turn/item. | `RuntimeConversationRef`, `RuntimeTurnLifecycle`, `RuntimeItemLifecycle` |
| `src/runtime-execution/runtime-correlation-state-store.ts` | Add | Run-scoped correlation persistence for thread/turn/callbacks. | `putCorrelation`, `getCorrelation`, `putCallbackMapping`, `resolveCallbackMapping` |
| `src/runtime-execution/adapters/codex/codex-thread-turn-gateway.ts` | Add | Codex thread/turn request handling and correlation extraction. | `startThread`, `resumeThread`, `startTurn`, `interruptTurn` |
| `src/runtime-execution/adapters/codex/codex-approval-callback-router.ts` | Add | Callback request registration + decision routing/idempotency. | `registerApprovalRequest`, `resolveDecision` |
| `src/runtime-execution/adapters/codex/codex-event-translator.ts` | Add | Codex notification -> canonical runtime event translation. | `translateNotification` |
| `src/runtime-execution/adapters/codex-app-server-runtime-adapter.ts` | Modify | Adapter orchestration only; delegates protocol details to focused modules. | `createRun`, `restoreRun`, `sendTurn`, `interruptRun`, `streamEvents` |
| `src/services/agent-streaming/runtime-event-envelope-normalizer.ts` | Modify | Dual identity envelope normalization + sequence assignment. | `normalizeRuntimeEnvelope` |
| `src/services/agent-streaming/runtime-event-message-mapper.ts` | Modify | Lifecycle-aware websocket mapping for thread/turn/item/tool/status events. | `mapRuntimeEventToServerMessage` |
| `src/run-history/services/run-history-service.ts` | Modify | Persist/query normalized runtime envelope with lifecycle/correlation metadata. | `onRuntimeEvent`, `readRuntimeEventsAfter` |

## Naming Decisions (Natural And Implementation-Friendly)

| Current Name | Proposed Name | Reason |
| --- | --- | --- |
| mixed codex adapter responsibilities | `codex-thread-turn-gateway` + `codex-approval-callback-router` + `codex-event-translator` | one module per protocol concern boundary |
| generic approval flow naming | `approveDecision` (ingress) | decouples from tool-only semantics and covers command/file/tool-input callbacks |
| ad hoc turn metadata fields | `RuntimeTurnLifecycle` | explicit lifecycle state model used across runtime/event/persistence layers |

## Data Models (If Needed)

- `RuntimeRunReference`
  - `runtimeKind: "autobyteus" | "codex_app_server"`
  - `sessionId: string | null`
  - `threadId: string | null`
  - `modelIdentifier: string`
  - `runtimeMetadata: Record<string, unknown> | null`

- `RuntimeConversationRef`
  - `runId: string`
  - `runtimeKind: string`
  - `threadId: string | null`
  - `activeTurnId: string | null`

- `RuntimeTurnLifecycle`
  - `threadId: string`
  - `turnId: string`
  - `status: "in_progress" | "completed" | "interrupted" | "failed"`
  - `startedAt: string | null`
  - `endedAt: string | null`

- `RuntimeItemLifecycle`
  - `threadId: string`
  - `turnId: string`
  - `itemId: string`
  - `itemType: string`
  - `status: "started" | "completed" | "failed"`

- `NormalizedRuntimeEventEnvelope`
  - server identity: `eventId`, `sequence`, `occurredAt`, `runId`, `sourceRuntime`
  - upstream correlation: `threadId?`, `turnId?`, `itemId?`, `approvalId?`
  - lifecycle tags: `lifecycleDomain`, `eventType`
  - payload: `Record<string, unknown>`

## Error Handling And Edge Cases

- Interrupt on non-active run -> deterministic `not_found`.
- Interrupt requested with missing correlation on codex runtime -> resolve from `RuntimeCorrelationStateStore`, else explicit `TURN_CORRELATION_MISSING`.
- Callback decision for stale/unknown token -> idempotent no-op + warning event.
- Callback decision with mismatched (`threadId`, `turnId`, `itemId`) -> reject with `CALLBACK_CORRELATION_MISMATCH`.
- Runtime event missing upstream IDs -> preserve nullable fields and mark `correlationCompleteness="partial"`; never drop event.
- Mapper failure after persistence -> send websocket protocol `ERROR` and continue stream.
- Reconnect cursor gap/out-of-range -> explicit replay gap error and full-sync instruction.

## Use-Case Coverage Matrix (Design Gate)

| use_case_id | Use Case | Primary | Fallback | Error | Runtime Call Stack Section |
| --- | --- | --- | --- | --- | --- |
| UC-001 | Create run with runtime kind selection | Yes | Yes | Yes | UC-001 |
| UC-002 | Send turn via command ingress | Yes | N/A | Yes | UC-002 |
| UC-003 | Continue run via migrated runtime reference | Yes | Yes | Yes | UC-003 |
| UC-004 | Stop generation via interrupt | Yes | Yes | Yes | UC-004 |
| UC-005 | Approval/denial via command ingress | Yes | Yes | Yes | UC-005 |
| UC-006 | Runtime event normalization + identity | Yes | Yes | Yes | UC-006 |
| UC-007 | Runtime model list/reload/preload | Yes | Yes | Yes | UC-007 |
| UC-008 | Runtime transport/session failure handling | Yes | Yes | Yes | UC-008 |
| UC-009 | Codex session/thread bootstrap | Yes | Yes | Yes | UC-009 |
| UC-010 | Thread/turn/item lifecycle mapping | Yes | Yes | Yes | UC-010 |
| UC-011 | Upstream correlation ID preservation | Yes | Yes | Yes | UC-011 |
| UC-012 | Reconnect catch-up with live handoff | Yes | Yes | Yes | UC-012 |

## Performance / Security Considerations

- Bound retries and backpressure in codex adapter and callback routing loops.
- Do not log secrets or full callback payload bodies.
- Keep one stream worker per run and isolate per-subscriber send failures.

## Migration / Rollout (If Needed)

1. Apply `C-048..C-056` contracts/modules and wire codex adapter delegation.
2. Update envelope normalization/mapping + run-history persistence schema usage.
3. Switch websocket handlers to interrupt/approval behavior with non-noop semantics.
4. Run integration tests for lifecycle translation, callback routing, replay/handoff, and interrupt correctness.

## Design Feedback Loop Notes (From Re-Investigation)

| Date | Trigger | Design Smell | Design Update Applied | Status |
| --- | --- | --- | --- | --- |
| 2026-02-20 | Re-investigation | TURN/thread/item and callback flows were implicit/under-specified at server boundary. | Added explicit lifecycle contracts, codex protocol sub-modules, dual identity envelope, and UC-009..UC-012 coverage. | Updated |
