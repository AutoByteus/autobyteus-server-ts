# Proposed-Design-Based Runtime Call Stacks (Debug-Trace Style)

## Conventions

- Frame format: `path/to/file.ts:functionName(args?)`
- Boundary tags: `[ENTRY]`, `[ASYNC]`, `[STATE]`, `[IO]`, `[FALLBACK]`, `[ERROR]`

## Design Basis

- Scope Classification: `Large`
- Call Stack Version: `v19`
- Source Artifact: `tickets/in-progress/codex-runtime-server-owned-redesign/proposed-design.md`
- Source Design Version: `v19`
- Referenced Sections: Target State, Change Inventory `C-001..C-056`, Use-Case Coverage Matrix `UC-001..UC-012`

## Future-State Modeling Rule (Mandatory)

- This document models target runtime-adapter behavior, not current local-runtime-only implementation.

## Use Case Index

- UC-001: Create run with runtime kind selection
- UC-002: Send turn on active run via command ingress
- UC-003: Continue inactive run via migrated runtime reference
- UC-004: Stop generation via deterministic runtime interrupt
- UC-005: Handle approval/denial decisions via command ingress
- UC-006: Runtime event normalization + deterministic identity envelope
- UC-007: Runtime-scoped model listing/reload/preload
- UC-008: Runtime transport/session failure handling
- UC-009: Codex runtime session/thread bootstrap
- UC-010: Codex thread/turn/item lifecycle mapping
- UC-011: Upstream correlation ID preservation for replay/audit parity
- UC-012: Reconnect catch-up and live handoff without gaps

---

## Use Case: UC-001 Create run with runtime kind selection

### Primary Runtime Call Stack

```text
[ENTRY] src/api/graphql/types/agent-instance.ts:sendAgentUserInput(...)
├── src/agent-execution/services/agent-instance-manager.ts:createAgentInstance(input)
│   ├── src/runtime-execution/runtime-composition-service.ts:createRun(input)
│   │   ├── src/runtime-management/runtime-kind.ts:normalizeRuntimeKind(input.runtimeKind)
│   │   ├── src/runtime-execution/runtime-adapter-registry.ts:resolveAdapter(runtimeKind)
│   │   ├── src/runtime-execution/adapters/<selected>-runtime-adapter.ts:createRun(...) [ASYNC]
│   │   └── src/runtime-execution/runtime-session-store.ts:put(runId, runtimeSession) [STATE]
│   ├── src/run-history/store/run-manifest-store.ts:writeManifest(runId, manifestV2) [IO]
│   └── src/run-history/services/run-history-service.ts:upsertRunHistoryRow(...ACTIVE...) [ASYNC][IO]
└── return runId
```

### Branching / Fallback Paths

```text
[FALLBACK] runtimeKind omitted
runtime-kind.ts:normalizeRuntimeKind(undefined)
└── return configured default runtime kind
```

```text
[ERROR] model unsupported for runtime
adapters/<selected>-runtime-adapter.ts:createRun(...)
└── throw RuntimeCreateError("MODEL_UNAVAILABLE_FOR_RUNTIME")
```

### Coverage Status

- Primary Path: `Covered`
- Fallback Path: `Covered`
- Error Path: `Covered`

---

## Use Case: UC-002 Send turn on active run via command ingress

### Primary Runtime Call Stack

```text
[ENTRY] src/services/agent-streaming/agent-stream-handler.ts:handleMessage(sessionId, SEND_MESSAGE)
├── src/services/agent-streaming/agent-session-manager.ts:getSession(sessionId)
├── src/runtime-execution/runtime-command-ingress-service.ts:sendTurn({ runId, userMessage }) [ASYNC]
│   ├── src/runtime-execution/runtime-session-store.ts:get(runId) [STATE]
│   ├── src/runtime-execution/runtime-adapter-registry.ts:resolveAdapter(runtimeKind)
│   └── src/runtime-execution/adapters/<selected>-runtime-adapter.ts:sendTurn(runId, userMessage) [ASYNC]
└── return send outcome with runtime correlation metadata
```

### Branching / Fallback Paths

```text
[ERROR] run session missing
runtime-command-ingress-service.ts:sendTurn(...)
└── throw RuntimeSessionNotFoundError
```

### Coverage Status

- Primary Path: `Covered`
- Fallback Path: `N/A`
- Error Path: `Covered`

---

## Use Case: UC-003 Continue inactive run via migrated runtime reference

### Primary Runtime Call Stack

```text
[ENTRY] src/run-history/services/run-continuation-service.ts:continueRun(input)
├── src/agent-execution/services/agent-instance-manager.ts:getAgentInstance(runId)
├── [if inactive] src/run-history/store/run-manifest-store.ts:readManifest(runId) [IO]
├── src/run-history/services/runtime-manifest-migration-service.ts:migrateAndValidate(manifest) [STATE]
├── src/runtime-execution/runtime-composition-service.ts:restoreRun(runId, migratedManifest) [ASYNC]
│   ├── runtime-kind.ts:normalizeRuntimeKind(migratedManifest.runtimeKind)
│   ├── runtime-adapter-registry.ts:resolveAdapter(runtimeKind)
│   ├── adapters/<selected>-runtime-adapter.ts:restoreRun(runtimeReference) [ASYNC]
│   └── runtime-session-store.ts:put(runId, restoredSession) [STATE]
├── src/runtime-execution/runtime-command-ingress-service.ts:sendTurn({ runId, userMessage }) [ASYNC]
└── src/run-history/services/run-history-service.ts:upsertRunHistoryRow(...ACTIVE...) [ASYNC][IO]
```

### Branching / Fallback Paths

```text
[FALLBACK] run already active
run-continuation-service.ts:continueRun(...)
├── src/run-history/services/active-run-override-policy.ts:resolveOverrideDecision(currentManifest, overrides)
└── runtime-command-ingress-service.ts:sendTurn(...)
```

```text
[ERROR] runtime reference invalid after migration
runtime-manifest-migration-service.ts:migrateAndValidate(...)
└── throw RunResumeError("RUNTIME_REFERENCE_INVALID")
```

### Coverage Status

- Primary Path: `Covered`
- Fallback Path: `Covered`
- Error Path: `Covered`

---

## Use Case: UC-004 Stop generation via deterministic runtime interrupt

### Primary Runtime Call Stack

```text
[ENTRY] src/services/agent-streaming/agent-stream-handler.ts:handleMessage(sessionId, STOP_GENERATION)
├── session-manager.ts:getSession(sessionId)
├── runtime-command-ingress-service.ts:interruptRun({ runId, turnId?, threadId? }) [ASYNC]
│   ├── runtime-session-store.ts:get(runId) [STATE]
│   ├── runtime-correlation-state-store.ts:getCorrelation(runId) [STATE]
│   ├── runtime-adapter-registry.ts:resolveAdapter(runtimeKind)
│   └── adapters/<selected>-runtime-adapter.ts:interruptRun({ runId, threadId, turnId }) [ASYNC]
└── handler sends deterministic interrupt outcome (`interrupted`/`not_found`)
```

### Branching / Fallback Paths

```text
[FALLBACK] threadId/turnId omitted by client
runtime-command-ingress-service.ts:interruptRun(...)
└── resolve correlation from runtime-correlation-state-store
```

```text
[ERROR] correlation missing for codex runtime
runtime-command-ingress-service.ts:interruptRun(...)
└── throw RuntimeInterruptError("TURN_CORRELATION_MISSING")
```

### Coverage Status

- Primary Path: `Covered`
- Fallback Path: `Covered`
- Error Path: `Covered`

---

## Use Case: UC-005 Handle approval/denial decisions via command ingress

### Primary Runtime Call Stack

```text
[ENTRY] src/services/agent-streaming/agent-team-stream-handler.ts:handleMessage(sessionId, APPROVE_TOOL|DENY_TOOL)
├── agent-team-stream-handler.ts:extractApprovalDecisionPayload(payload)
├── runtime-command-ingress-service.ts:approveDecision({ runId, token, approved, reason }) [ASYNC]
│   ├── runtime-session-store.ts:get(runId) [STATE]
│   ├── runtime-correlation-state-store.ts:resolveCallbackMapping(token) [STATE]
│   ├── runtime-adapter-registry.ts:resolveAdapter(runtimeKind)
│   └── adapters/codex-app-server-runtime-adapter.ts:approveDecision(callbackContext, approved, reason) [ASYNC]
│       └── adapters/codex/codex-approval-callback-router.ts:resolveDecision(...) [ASYNC]
└── runtime emits callback outcome + follow-up turn/item events
```

### Branching / Fallback Paths

```text
[FALLBACK] approvalId missing in callback context
codex-approval-callback-router.ts:resolveDecision(...)
└── route by (threadId, turnId, itemId) tuple
```

```text
[ERROR] stale/unknown callback token
runtime-correlation-state-store.ts:resolveCallbackMapping(token)
└── return idempotent no-op + warning event
```

### Coverage Status

- Primary Path: `Covered`
- Fallback Path: `Covered`
- Error Path: `Covered`

---

## Use Case: UC-006 Runtime event normalization + deterministic identity envelope

### Primary Runtime Call Stack

```text
[ENTRY] src/services/agent-streaming/runtime-run-stream-orchestrator.ts:ensureRunWorker(runId)
├── runtime-session-store.ts:get(runId) [STATE]
├── runtime-adapter-registry.ts:resolveAdapter(runtimeKind)
├── adapters/<selected>-runtime-adapter.ts:streamEvents(runId) [ASYNC]
└── for each runtime event:
    ├── runtime-event-sequence-ledger.ts:nextSequence(runId) [STATE]
    ├── runtime-event-envelope-normalizer.ts:normalizeRuntimeEnvelope({ runId, sequence, event }) [STATE]
    │   └── includes server identity + upstream correlation IDs
    ├── run-history-service.ts:onRuntimeEvent(runId, normalizedEnvelope) [ASYNC][IO]
    ├── runtime-event-message-mapper.ts:mapRuntimeEventToServerMessage(normalizedEnvelope)
    └── runtime-event-subscriber-hub.ts:broadcast(runId, serverMessage) [ASYNC]
```

### Branching / Fallback Paths

```text
[FALLBACK] upstream correlation fields partially missing
runtime-event-envelope-normalizer.ts:normalizeRuntimeEnvelope(...)
└── keep nullable correlation fields + set `correlationCompleteness="partial"`
```

```text
[ERROR] websocket mapping failure
runtime-event-message-mapper.ts:mapRuntimeEventToServerMessage(...)
└── emit protocol ERROR and continue stream (event already persisted)
```

### Coverage Status

- Primary Path: `Covered`
- Fallback Path: `Covered`
- Error Path: `Covered`

---

## Use Case: UC-007 Runtime-scoped model listing/reload/preload

### Primary Runtime Call Stack

```text
[ENTRY] src/api/graphql/types/llm-provider.ts:availableLlmProvidersWithModels(runtimeKind?)
├── runtime-kind.ts:normalizeRuntimeKind(runtimeKind)
├── runtime-model-catalog-service.ts:listModels(runtimeKind) [ASYNC]
│   ├── runtime-model-provider-registry.ts:resolve(runtimeKind)
│   └── providers/<selected>.ts:listModels(...) [ASYNC][IO?]
└── resolver returns provider/model payload
```

```text
[ENTRY] src/startup/cache-preloader.ts:preloadCaches(...)
└── runtime-model-catalog-service.ts:preloadAllRuntimes() [ASYNC]
```

### Branching / Fallback Paths

```text
[FALLBACK] runtimeKind omitted
runtime-kind.ts:normalizeRuntimeKind(undefined)
└── default runtime kind
```

```text
[ERROR] runtime provider not found
runtime-model-provider-registry.ts:resolve(runtimeKind)
└── throw RuntimeModelProviderNotFoundError
```

### Coverage Status

- Primary Path: `Covered`
- Fallback Path: `Covered`
- Error Path: `Covered`

---

## Use Case: UC-008 Runtime transport/session failure handling

### Primary Runtime Call Stack

```text
[ENTRY] src/runtime-execution/adapters/codex-app-server-runtime-adapter.ts:<stream or command>
├── codex transport client call [IO]
└── throw transport error
    ├── runtime-session-store.ts:delete(runId) [STATE]
    ├── run-history-service.ts:onRuntimeError(runId, details) [ASYNC][IO]
    └── agent-stream-handler.ts:emit websocket ERROR
```

### Branching / Fallback Paths

```text
[FALLBACK] transient transport error
codex adapter transport policy
└── bounded retry + continue
```

```text
[ERROR] retry budget exhausted
codex adapter transport policy
└── terminal runtime error + cleanup
```

### Coverage Status

- Primary Path: `Covered`
- Fallback Path: `Covered`
- Error Path: `Covered`

---

## Use Case: UC-009 Codex runtime session/thread bootstrap

### Primary Runtime Call Stack

```text
[ENTRY] runtime-composition-service.ts:createRun(input{runtimeKind=codex_app_server})
├── codex-app-server-runtime-adapter.ts:createRun(config) [ASYNC]
│   ├── adapters/codex/codex-thread-turn-gateway.ts:startThread(config) [ASYNC]
│   ├── runtime-correlation-state-store.ts:putCorrelation(runId, { threadId, activeTurnId:null }) [STATE]
│   └── return runtime session reference
└── run-manifest-store.ts:writeManifest(runId, runtimeReference{threadId,...}) [IO]
```

### Branching / Fallback Paths

```text
[FALLBACK] resume existing thread
codex-thread-turn-gateway.ts:resumeThread(threadId)
└── correlation store updated with resumed thread context
```

```text
[ERROR] thread bootstrap fails
codex-thread-turn-gateway.ts:startThread(...)
└── throw RuntimeCreateError("CODEX_THREAD_BOOTSTRAP_FAILED")
```

### Coverage Status

- Primary Path: `Covered`
- Fallback Path: `Covered`
- Error Path: `Covered`

---

## Use Case: UC-010 Codex thread/turn/item lifecycle mapping

### Primary Runtime Call Stack

```text
[ENTRY] codex-app-server-runtime-adapter.ts:streamEvents(runId)
└── adapters/codex/codex-event-translator.ts:translateNotification(notification)
    ├── if `turn/started|turn/completed|turn/plan/updated|turn/diff/updated`:
    │   ├── build RuntimeTurnLifecycle event
    │   └── runtime-correlation-state-store.ts:putCorrelation(runId, latestTurnRef) [STATE]
    ├── if `item/started|item/completed|item/*/delta`:
    │   └── build RuntimeItemLifecycle/ItemDelta event
    └── emit canonical runtime event to orchestrator
```

### Branching / Fallback Paths

```text
[FALLBACK] unknown but valid protocol notification
codex-event-translator.ts
└── emit lifecycleDomain="raw_protocol" event for envelope + persistence
```

```text
[ERROR] invalid payload for known lifecycle notification
codex-event-translator.ts
└── throw RuntimeEventTranslationError("CODEX_NOTIFICATION_PAYLOAD_INVALID")
```

### Coverage Status

- Primary Path: `Covered`
- Fallback Path: `Covered`
- Error Path: `Covered`

---

## Use Case: UC-011 Upstream correlation ID preservation for replay/audit parity

### Primary Runtime Call Stack

```text
[ENTRY] runtime-event-envelope-normalizer.ts:normalizeRuntimeEnvelope({ runId, sequence, event })
├── map server identity: eventId, sequence, occurredAt, runId
├── map upstream correlation: threadId, turnId, itemId, approvalId
├── run-history-service.ts:onRuntimeEvent(runId, envelope) [ASYNC][IO]
└── runtime-event-message-mapper.ts:mapRuntimeEventToServerMessage(envelope)
```

### Branching / Fallback Paths

```text
[FALLBACK] non-codex runtime event without upstream ids
envelope-normalizer.ts
└── correlation fields remain null; server identity remains complete
```

```text
[ERROR] persistence receives non-normalized envelope
run-history-service.ts:onRuntimeEvent(...)
└── throw RuntimeEventEnvelopeMismatchError("RUNTIME_EVENT_ENVELOPE_MISMATCH")
```

### Coverage Status

- Primary Path: `Covered`
- Fallback Path: `Covered`
- Error Path: `Covered`

---

## Use Case: UC-012 Reconnect catch-up and live handoff without gaps

### Primary Runtime Call Stack

```text
[ENTRY] agent-stream-handler.ts:connect(connection, runId, sessionId, afterSequence?)
├── runtime-event-subscriber-hub.ts:subscribePending({ runId, sessionId, mode:"buffer_live" }) -> connectAttemptId [STATE]
├── runtime-event-catchup-service.ts:replayFromSequence({ runId, sessionId, connectAttemptId, afterSequence }) [ASYNC][IO]
│   ├── run-history-service.ts:readRuntimeEventsAfter(runId, afterSequence, includeHighWatermark=true) [IO]
│   └── runtime-event-subscriber-hub.ts:sendToSession(sessionId, replayMessage) [ASYNC]
├── runtime-event-subscriber-hub.ts:activateAfterReplay({ sessionId, connectAttemptId, replayHighWatermark }) [STATE]
│   └── drain buffered live events with sequence > replayHighWatermark
└── runtime-run-stream-orchestrator.ts:ensureRunWorker(runId) [ASYNC]
```

### Branching / Fallback Paths

```text
[FALLBACK] first connect without cursor
afterSequence absent
└── replay service returns no replay events, activate directly
```

```text
[ERROR] replay delivery aborted (socket close/send failure)
agent-stream-handler.ts:connect(...)
└── runtime-event-subscriber-hub.ts:abortConnectSession({ sessionId, connectAttemptId, phase:"pending" })
```

```text
[ERROR] worker start fails after activation
agent-stream-handler.ts:connect(...)
└── runtime-event-subscriber-hub.ts:abortConnectSession({ sessionId, connectAttemptId, phase:"active" })
```

### Coverage Status

- Primary Path: `Covered`
- Fallback Path: `Covered`
- Error Path: `Covered`
