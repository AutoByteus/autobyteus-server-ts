# Prompt Engineering

## Scope

Versioned prompt management, caching, lookup, and synchronization.

## TS Source

- `src/prompt-engineering`
- `src/api/graphql/types/prompt.ts`
- `src/agent-tools/prompt-engineering`

## Main Services

- `src/prompt-engineering/services/prompt-service.ts`
- `src/prompt-engineering/services/prompt-sync-service.ts`

## Notes

Prompt service and cached provider are singleton-backed in TS to avoid repeated cache initialization.
