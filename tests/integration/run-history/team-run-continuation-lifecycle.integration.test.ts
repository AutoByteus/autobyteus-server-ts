import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamRunContinuationService } from "../../../src/run-history/services/team-run-continuation-service.js";
import { TeamRunHistoryService } from "../../../src/run-history/services/team-run-history-service.js";
import { TeamRunManifestStore } from "../../../src/run-history/store/team-run-manifest-store.js";
import type { TeamRunManifest } from "../../../src/run-history/domain/team-models.js";

const createTempMemoryDir = async (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), "autobyteus-team-run-continuation-integration-"));

const buildManifest = (teamId: string, nowIso: string): TeamRunManifest => ({
  teamId,
  teamDefinitionId: "team-def-1",
  teamDefinitionName: "Team One",
  coordinatorMemberRouteKey: "coordinator",
  runVersion: 1,
  createdAt: nowIso,
  updatedAt: nowIso,
  memberBindings: [
    {
      memberRouteKey: "coordinator",
      memberName: "coordinator",
      memberAgentId: "member_coordinator_1",
      agentDefinitionId: "agent-def-1",
      llmModelIdentifier: "gpt-4o-mini",
      autoExecuteTools: true,
      llmConfig: null,
      workspaceRootPath: "/tmp/ws-coordinator",
      hostNodeId: "node-local",
    },
    {
      memberRouteKey: "writer",
      memberName: "writer",
      memberAgentId: "member_writer_1",
      agentDefinitionId: "agent-def-2",
      llmModelIdentifier: "gpt-4o-mini",
      autoExecuteTools: false,
      llmConfig: { temperature: 0.2 },
      workspaceRootPath: "/tmp/ws-writer",
      hostNodeId: "node-local",
    },
  ],
});

describe("TeamRunContinuationService integration", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("restores from manifest, dispatches, then reruns after terminate on single node", async () => {
    const memoryDir = await createTempMemoryDir();
    const teamId = "team-integration-1";
    const nowIso = new Date().toISOString();
    const manifest = buildManifest(teamId, nowIso);

    const activeTeams = new Set<string>();
    const getTeamInstance = vi.fn((id: string) => (activeTeams.has(id) ? ({ teamId: id } as any) : null));
    const createTeamInstanceWithId = vi.fn(async (id: string) => {
      activeTeams.add(id);
      return id;
    });
    const terminateTeamInstance = vi.fn(async (id: string) => {
      activeTeams.delete(id);
      return true;
    });
    const teamInstanceManager = {
      getTeamInstance,
      createTeamInstanceWithId,
      terminateTeamInstance,
    } as any;

    const dispatchUserMessage = vi.fn(async () => undefined);
    const teamCommandIngressService = { dispatchUserMessage } as any;
    const ensureWorkspaceByRootPath = vi.fn(async (workspaceRootPath: string) => {
      if (workspaceRootPath.endsWith("coordinator")) {
        return { workspaceId: "ws-coordinator" };
      }
      return { workspaceId: "ws-writer" };
    });
    const workspaceManager = { ensureWorkspaceByRootPath } as any;

    const teamRunHistoryService = new TeamRunHistoryService(memoryDir, { teamInstanceManager });
    const continuationService = new TeamRunContinuationService({
      memoryDir,
      teamInstanceManager,
      teamCommandIngressService,
      teamRunHistoryService,
      workspaceManager,
    });

    const manifestStore = new TeamRunManifestStore(memoryDir);
    await manifestStore.writeManifest(teamId, manifest);
    await teamRunHistoryService.upsertTeamRunHistoryRow({
      teamId,
      manifest,
      summary: "seed summary",
      lastKnownStatus: "IDLE",
      lastActivityAt: nowIso,
    });

    const first = await continuationService.continueTeamRun({
      teamId,
      targetMemberRouteKey: "coordinator",
      userInput: {
        content: "first message",
        contextFiles: null,
      },
    } as any);

    expect(first).toEqual({
      teamId,
      restored: true,
    });
    expect(createTeamInstanceWithId).toHaveBeenCalledTimes(1);
    expect(createTeamInstanceWithId).toHaveBeenCalledWith(
      teamId,
      "team-def-1",
      expect.arrayContaining([
        expect.objectContaining({
          memberName: "coordinator",
          memberAgentId: "member_coordinator_1",
          workspaceId: "ws-coordinator",
        }),
        expect.objectContaining({
          memberName: "writer",
          memberAgentId: "member_writer_1",
          workspaceId: "ws-writer",
        }),
      ]),
    );
    expect(dispatchUserMessage).toHaveBeenCalledTimes(1);
    expect(dispatchUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId,
        targetMemberName: "coordinator",
      }),
    );

    const second = await continuationService.continueTeamRun({
      teamId,
      targetMemberRouteKey: "writer",
      userInput: {
        content: "second message",
        contextFiles: null,
      },
    } as any);
    expect(second).toEqual({
      teamId,
      restored: false,
    });
    expect(createTeamInstanceWithId).toHaveBeenCalledTimes(1);
    expect(dispatchUserMessage).toHaveBeenCalledTimes(2);

    await terminateTeamInstance(teamId);
    const third = await continuationService.continueTeamRun({
      teamId,
      targetMemberRouteKey: "writer",
      userInput: {
        content: "third message",
        contextFiles: null,
      },
    } as any);
    expect(third).toEqual({
      teamId,
      restored: true,
    });
    expect(createTeamInstanceWithId).toHaveBeenCalledTimes(2);
    expect(dispatchUserMessage).toHaveBeenCalledTimes(3);

    const listed = await teamRunHistoryService.listTeamRunHistory();
    const row = listed.find((item) => item.teamId === teamId);
    expect(row?.lastKnownStatus).toBe("ACTIVE");
    expect(row?.summary).toBe("third message");

    await fs.rm(memoryDir, { recursive: true, force: true });
  });

  it("rolls back restored runtime when dispatch fails", async () => {
    const memoryDir = await createTempMemoryDir();
    const teamId = "team-integration-rollback";
    const nowIso = new Date().toISOString();
    const manifest = buildManifest(teamId, nowIso);

    const activeTeams = new Set<string>();
    const createTeamInstanceWithId = vi.fn(async (id: string) => {
      activeTeams.add(id);
      return id;
    });
    const terminateTeamInstance = vi.fn(async (id: string) => {
      activeTeams.delete(id);
      return true;
    });
    const teamInstanceManager = {
      getTeamInstance: (id: string) => (activeTeams.has(id) ? ({ teamId: id } as any) : null),
      createTeamInstanceWithId,
      terminateTeamInstance,
    } as any;

    const teamRunHistoryService = new TeamRunHistoryService(memoryDir, { teamInstanceManager });
    const continuationService = new TeamRunContinuationService({
      memoryDir,
      teamInstanceManager,
      teamRunHistoryService,
      teamCommandIngressService: {
        dispatchUserMessage: vi.fn(async () => {
          throw new Error("dispatch failed");
        }),
      } as any,
      workspaceManager: {
        ensureWorkspaceByRootPath: vi.fn(async () => ({ workspaceId: "ws-id" })),
      } as any,
    });

    const manifestStore = new TeamRunManifestStore(memoryDir);
    await manifestStore.writeManifest(teamId, manifest);
    await teamRunHistoryService.upsertTeamRunHistoryRow({
      teamId,
      manifest,
      summary: "",
      lastKnownStatus: "IDLE",
      lastActivityAt: nowIso,
    });

    await expect(
      continuationService.continueTeamRun({
        teamId,
        targetMemberRouteKey: "coordinator",
        userInput: {
          content: "should fail",
          contextFiles: null,
        },
      } as any),
    ).rejects.toThrow("dispatch failed");

    expect(createTeamInstanceWithId).toHaveBeenCalledTimes(1);
    expect(terminateTeamInstance).toHaveBeenCalledWith(teamId);
    expect(activeTeams.has(teamId)).toBe(false);

    await fs.rm(memoryDir, { recursive: true, force: true });
  });
});
