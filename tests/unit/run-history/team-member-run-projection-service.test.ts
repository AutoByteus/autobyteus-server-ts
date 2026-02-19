import { describe, expect, it, vi } from "vitest";
import { TeamMemberRunProjectionService } from "../../../src/run-history/services/team-member-run-projection-service.js";

describe("TeamMemberRunProjectionService", () => {
  it("returns local projection immediately when local conversation is non-empty", async () => {
    const getTeamRunResumeConfig = vi.fn().mockResolvedValue({
      teamId: "team-1",
      manifest: {
        teamDefinitionId: "team-def-1",
        memberBindings: [
          {
            memberRouteKey: "student",
            memberName: "student",
            memberAgentId: "member-student",
            hostNodeId: "node-remote",
          },
        ],
      },
    });
    const localProjection = {
      agentId: "member-student",
      summary: "local summary",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      conversation: [{ role: "user", content: "hello" }],
    };
    const getProjection = vi.fn().mockReturnValue(localProjection);
    const fetchFn = vi.fn();

    const service = new TeamMemberRunProjectionService({
      teamRunHistoryService: {
        getTeamRunResumeConfig,
      } as any,
      runProjectionService: {
        getProjection,
      } as any,
      teamDefinitionService: {
        getDefinitionById: vi.fn(),
      } as any,
      fetchFn: fetchFn as any,
      resolveNodeBaseUrl: vi.fn().mockReturnValue("http://remote:8000"),
      isLocalNodeId: vi.fn().mockReturnValue(false),
    });

    const result = await service.getProjection("team-1", "student");

    expect(result).toEqual(localProjection);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back to remote projection when local conversation is empty", async () => {
    const getTeamRunResumeConfig = vi.fn().mockResolvedValue({
      teamId: "team-1",
      manifest: {
        teamDefinitionId: "team-def-1",
        memberBindings: [
          {
            memberRouteKey: "student",
            memberName: "student",
            memberAgentId: "member-student",
            hostNodeId: null,
          },
        ],
      },
    });
    const localProjection = {
      agentId: "member-student",
      summary: null,
      lastActivityAt: null,
      conversation: [],
    };
    const getProjection = vi.fn().mockReturnValue(localProjection);
    const getDefinitionById = vi.fn().mockResolvedValue({
      nodes: [
        {
          memberName: "student",
          homeNodeId: "node-remote",
        },
      ],
    });
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          getRunProjection: {
            agentId: "member-student",
            summary: "remote summary",
            lastActivityAt: "2026-01-01T00:01:00.000Z",
            conversation: [
              { role: "user", content: "hi remote" },
              { role: "assistant", content: "hello remote" },
            ],
          },
        },
      }),
    });

    const service = new TeamMemberRunProjectionService({
      teamRunHistoryService: {
        getTeamRunResumeConfig,
      } as any,
      runProjectionService: {
        getProjection,
      } as any,
      teamDefinitionService: {
        getDefinitionById,
      } as any,
      fetchFn: fetchFn as any,
      resolveNodeBaseUrl: vi.fn().mockReturnValue("http://remote:8000"),
      isLocalNodeId: vi.fn((nodeId: string) => nodeId === "node-local"),
    });

    const result = await service.getProjection("team-1", "student");

    expect(result.summary).toBe("remote summary");
    expect(result.conversation).toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns local fallback when remote lookup fails", async () => {
    const getTeamRunResumeConfig = vi.fn().mockResolvedValue({
      teamId: "team-1",
      manifest: {
        teamDefinitionId: "team-def-1",
        memberBindings: [
          {
            memberRouteKey: "student",
            memberName: "student",
            memberAgentId: "member-student",
            hostNodeId: "node-remote",
          },
        ],
      },
    });
    const localProjection = {
      agentId: "member-student",
      summary: null,
      lastActivityAt: null,
      conversation: [],
    };
    const getProjection = vi.fn().mockReturnValue(localProjection);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const service = new TeamMemberRunProjectionService({
      teamRunHistoryService: {
        getTeamRunResumeConfig,
      } as any,
      runProjectionService: {
        getProjection,
      } as any,
      teamDefinitionService: {
        getDefinitionById: vi.fn(),
      } as any,
      fetchFn: fetchFn as any,
      resolveNodeBaseUrl: vi.fn().mockReturnValue("http://remote:8000"),
      isLocalNodeId: vi.fn().mockReturnValue(false),
    });

    const result = await service.getProjection("team-1", "student");

    expect(result).toEqual(localProjection);
  });
});
