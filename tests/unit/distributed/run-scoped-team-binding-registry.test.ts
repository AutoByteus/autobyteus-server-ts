import { describe, expect, it } from "vitest";
import {
  RunScopedTeamBindingRegistry,
  TeamRunNotBoundError,
} from "../../../src/distributed/runtime-binding/run-scoped-team-binding-registry.js";

describe("RunScopedTeamBindingRegistry", () => {
  it("binds and resolves run-scoped team runtime entries", () => {
    const registry = new RunScopedTeamBindingRegistry();
    registry.bindRun({
      teamRunId: "run-1",
      runVersion: 2,
      teamDefinitionId: "def-1",
      runtimeTeamId: "team-runtime-1",
      memberConfigs: [
        {
          memberName: "leader",
          agentDefinitionId: "agent-1",
          llmModelIdentifier: "gpt-4o-mini",
          autoExecuteTools: true,
          workspaceId: "workspace-1",
          llmConfig: { temperature: 0.1 },
        },
      ],
    });

    const resolved = registry.resolveRun("run-1");
    expect(resolved.teamDefinitionId).toBe("def-1");
    expect(resolved.runtimeTeamId).toBe("team-runtime-1");
    expect(resolved.memberConfigs[0]?.memberName).toBe("leader");

    resolved.memberConfigs[0]!.memberName = "mutated";
    const reResolved = registry.resolveRun("run-1");
    expect(reResolved.memberConfigs[0]?.memberName).toBe("leader");
  });

  it("throws when resolving a missing run binding", () => {
    const registry = new RunScopedTeamBindingRegistry();
    expect(() => registry.resolveRun("missing-run")).toThrow(TeamRunNotBoundError);
    expect(registry.tryResolveRun("missing-run")).toBeNull();
  });

  it("unbinds run bindings deterministically", () => {
    const registry = new RunScopedTeamBindingRegistry();
    registry.bindRun({
      teamRunId: "run-2",
      runVersion: 1,
      teamDefinitionId: "def-2",
      runtimeTeamId: "team-runtime-2",
      memberConfigs: [],
    });

    expect(registry.unbindRun("run-2")).toBe(true);
    expect(registry.unbindRun("run-2")).toBe(false);
    expect(registry.tryResolveRun("run-2")).toBeNull();
  });
});
