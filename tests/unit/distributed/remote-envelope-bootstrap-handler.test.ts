import { describe, expect, it, vi } from "vitest";
import type { TeamEnvelope } from "../../../src/distributed/envelope/envelope-builder.js";
import { createDispatchRunBootstrapHandler } from "../../../src/distributed/bootstrap/remote-envelope-bootstrap-handler.js";
import { WorkerRunLifecycleCoordinator } from "../../../src/distributed/bootstrap/worker-run-lifecycle-coordinator.js";

const buildRunBootstrapEnvelope = (): TeamEnvelope => ({
  envelopeId: "env-1",
  teamRunId: "run-1",
  runVersion: "v1",
  kind: "RUN_BOOTSTRAP",
  payload: {
    teamDefinitionId: "team-def-host",
    hostNodeId: "host-1",
    memberBindings: [
      {
        memberName: "student",
        agentDefinitionId: "agent-def-1",
        llmModelIdentifier: "model-1",
        autoExecuteTools: false,
      },
    ],
  },
});

const createLifecycleCoordinator = (): WorkerRunLifecycleCoordinator =>
  new WorkerRunLifecycleCoordinator({
    sourceNodeId: "worker-1",
    projectRemoteExecutionEventsFromTeamEvent: () => [],
    publishRemoteExecutionEventToHost: async () => undefined,
  });

describe("remote envelope bootstrap handler", () => {
  it("marks existing bound run as worker-managed when runtime team still exists", async () => {
    const workerRunLifecycleCoordinator = createLifecycleCoordinator();
    const markSpy = vi.spyOn(workerRunLifecycleCoordinator, "markWorkerManagedRun");
    const teardownSpy = vi.spyOn(workerRunLifecycleCoordinator, "teardownRun");
    const bindRun = vi.fn();
    const unbindRun = vi.fn();
    const finalizeRun = vi.fn();

    const dispatchRunBootstrap = createDispatchRunBootstrapHandler({
      hostNodeId: "worker-1",
      teamInstanceManager: {
        getTeamInstance: vi.fn(() => ({ teamId: "runtime-existing" })),
        getTeamIdByDefinitionId: vi.fn(() => "runtime-existing"),
        createTeamInstance: vi.fn(async () => "runtime-new"),
        terminateTeamInstance: vi.fn(async () => undefined),
        getTeamMemberConfigsByDefinitionId: vi.fn(() => []),
        getTeamEventStream: vi.fn(() => null),
      } as any,
      runScopedTeamBindingRegistry: {
        tryResolveRun: vi.fn(() => ({
          teamRunId: "run-1",
          runtimeTeamId: "runtime-existing",
        })),
        bindRun,
        unbindRun,
      } as any,
      teamEventAggregator: {
        finalizeRun,
      } as any,
      hostNodeBridgeClient: {
        sendCommand: vi.fn(async () => undefined),
      } as any,
      workerRunLifecycleCoordinator,
      resolveWorkerTeamDefinitionId: vi.fn(async () => "team-def-worker"),
      ensureHostNodeDirectoryEntryForWorkerRun: vi.fn(),
    });

    await dispatchRunBootstrap(buildRunBootstrapEnvelope());

    expect(markSpy).toHaveBeenCalledWith("run-1", "host-1");
    expect(teardownSpy).not.toHaveBeenCalled();
    expect(bindRun).not.toHaveBeenCalled();
    expect(unbindRun).not.toHaveBeenCalled();
    expect(finalizeRun).not.toHaveBeenCalled();
  });

  it("binds run and installs worker uplink routing port for new runtime team", async () => {
    const workerRunLifecycleCoordinator = createLifecycleCoordinator();
    const replaceForwarderSpy = vi
      .spyOn(workerRunLifecycleCoordinator, "replaceEventForwarder")
      .mockResolvedValue(undefined);
    const teamManager = { setTeamRoutingPort: vi.fn() };
    const bindRun = vi.fn();
    const getTeamEventStream = vi.fn(() => ({ allEvents: async function* () {}, close: async () => undefined }));

    const dispatchRunBootstrap = createDispatchRunBootstrapHandler({
      hostNodeId: "worker-1",
      teamInstanceManager: {
        getTeamInstance: vi.fn((teamId: string) =>
          teamId === "runtime-1" ? ({ runtime: { context: { teamManager } } } as any) : null,
        ),
        getTeamIdByDefinitionId: vi.fn(() => null),
        createTeamInstance: vi.fn(async () => "runtime-1"),
        terminateTeamInstance: vi.fn(async () => undefined),
        getTeamMemberConfigsByDefinitionId: vi.fn(() => []),
        getTeamEventStream,
      } as any,
      runScopedTeamBindingRegistry: {
        tryResolveRun: vi.fn(() => null),
        bindRun,
        unbindRun: vi.fn(),
      } as any,
      teamEventAggregator: {
        finalizeRun: vi.fn(),
      } as any,
      hostNodeBridgeClient: {
        sendCommand: vi.fn(async () => undefined),
      } as any,
      workerRunLifecycleCoordinator,
      resolveWorkerTeamDefinitionId: vi.fn(async () => "team-def-worker"),
      ensureHostNodeDirectoryEntryForWorkerRun: vi.fn(),
    });

    await dispatchRunBootstrap(buildRunBootstrapEnvelope());

    expect(bindRun).toHaveBeenCalledTimes(1);
    expect(bindRun).toHaveBeenCalledWith(
      expect.objectContaining({
        teamRunId: "run-1",
        teamDefinitionId: "team-def-host",
        runtimeTeamId: "runtime-1",
      }),
    );
    expect(teamManager.setTeamRoutingPort).toHaveBeenCalledTimes(1);
    expect(replaceForwarderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        teamRunId: "run-1",
        runtimeTeamId: "runtime-1",
      }),
    );
    expect(getTeamEventStream).toHaveBeenCalledWith("runtime-1");
  });
});
