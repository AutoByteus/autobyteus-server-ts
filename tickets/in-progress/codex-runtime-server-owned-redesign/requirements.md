# Requirements - codex-runtime-server-owned-redesign

## Status

`Refined`

## Goal / Problem Statement

Integrate Codex app-server as a first-class server-owned runtime in `autobyteus-server-ts` without weakening `autobyteus-ts` core invariants, while preserving deterministic run control, explicit thread/turn/item lifecycle handling, websocket streaming parity, run-history continuity, and approval/interrupt correctness.

## Scope Classification

- Classification: `Large`
- Rationale:
  - Cross-cutting backend impact (GraphQL, websocket routes, runtime execution, run-history schema/migration, model catalog, distributed/team ingress).
  - Adapter/protocol translation requires explicit handling of Codex app-server thread/turn/item lifecycle and approval callback contracts.
  - High regression risk across interrupt, replay, and persistence semantics if lifecycle identity is not modeled explicitly.

## In-Scope Use Cases

- `UC-001` Create run with explicit runtime kind selection and adapter-backed runtime session creation.
- `UC-002` Send user turn on active run through runtime command ingress.
- `UC-003` Continue inactive run via migrated manifest runtime reference with strict validation.
- `UC-004` Stop generation via deterministic runtime interrupt (including not-found behavior).
- `UC-005` Handle approval/denial decisions through runtime ingress.
- `UC-006` Normalize runtime events to websocket payloads with deterministic envelope identity and replay-safe sequencing.
- `UC-007` Provide runtime-scoped model listing/reload/preload from one catalog path.
- `UC-008` Handle runtime transport/session failures with deterministic cleanup and status updates.
- `UC-009` Initialize Codex app-server runtime session + thread context for each run.
- `UC-010` Map Codex thread/turn/item lifecycle to server run/session state (`thread start/resume/read`, `turn started/completed/interrupted/failed`, item started/completed/deltas).
- `UC-011` Preserve upstream Codex correlation IDs (`threadId`, `turnId`, `itemId`, `approvalId?`) alongside server sequence metadata for replay/audit parity.
- `UC-012` Support reconnect catch-up and live handoff without event gaps under multi-session websocket subscriptions.

## Acceptance Criteria

1. Runtime kind and runtime reference are persisted in manifest and validated on resume; invalid references fail fast.
2. `STOP_GENERATION` is no longer no-op for single-agent or team websocket paths.
3. Codex adapter exposes explicit translation contracts for thread/turn/item lifecycle and interrupt correlation.
4. Approval callback routing supports protocol-native callback methods (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`) with deterministic decision correlation.
5. Websocket runtime events include stable server ordering metadata plus protocol-native correlation fields where available.
6. Persistence and websocket mapping consume equivalent normalized runtime event envelope identity data (no divergence).
7. Reconnect catch-up guarantees no missing events between replay and live activation.
8. Model listing/reload/preload paths are runtime-catalog-only (no direct legacy `LlmModelService` runtime-path usage).
9. Team ingress approval semantics preserve concurrency/idempotency guarantees equivalent to current token policy.
10. Integration tests cover critical error/fallback paths for interrupt, callback approval routing, replay abort, and transport failure.

## Constraints / Dependencies

- No backward compatibility shims or legacy dual-path behavior.
- `autobyteus-ts` core runtime contracts remain unchanged in this ticket.
- Codex app-server protocol behavior must be validated against generated schema and runtime behavior from installed CLI.
- Performance guardrails are required for high-volume item/output delta event persistence and fanout.

## Assumptions

- Codex app-server transport is available via local process or network endpoint controlled by server runtime adapter.
- Existing run-history storage can be extended for runtime metadata and event identity without replacing storage backend.
- UI/runtime selector implementation details remain outside this backend ticket.

## Open Questions / Risks

- Minimum v1 app-server method surface area: full thread lifecycle parity vs constrained subset.
- Team-level Codex integration boundary: shared adapter path vs dedicated team adapter.
- Long-running stream retention strategy for replay cursor windows under heavy output volume.
- Exact fallback behavior when protocol version drift is detected between server and `codex-cli`.

## Non-Goals

- Frontend runtime selector UX implementation.
- Mixed-runtime execution within a single run.
- Keeping legacy local-runtime-only assumptions for continuation or stop-generation behavior.
