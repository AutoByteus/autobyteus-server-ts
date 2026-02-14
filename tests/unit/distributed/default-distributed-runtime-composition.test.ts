import { describe, expect, it } from "vitest";
import {
  AgentEventRebroadcastPayload,
  AgentTeamStatusUpdateData,
  AgentTeamStreamEvent,
  StreamEvent,
  StreamEventType,
  SubTeamEventRebroadcastPayload,
} from "autobyteus-ts";
import { projectRemoteExecutionEventsFromTeamEvent } from "../../../src/distributed/bootstrap/default-distributed-runtime-composition.js";

describe("default distributed runtime composition event projection", () => {
  it("projects top-level agent events into remote execution event payloads", () => {
    const projected = projectRemoteExecutionEventsFromTeamEvent({
      teamEvent: new AgentTeamStreamEvent({
        team_id: "team-1",
        event_source_type: "AGENT",
        data: new AgentEventRebroadcastPayload({
          agent_name: "worker-a",
          agent_event: new StreamEvent({
            event_id: "evt-1",
            event_type: StreamEventType.ASSISTANT_CHUNK,
            agent_id: "agent-1",
            data: { content: "hello", is_complete: false },
          }),
        }),
      }),
    });

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      memberName: "worker-a",
      agentId: "agent-1",
      eventType: "assistant_chunk",
    });
    expect(projected[0]?.sourceEventId).toContain(":worker-a:assistant_chunk");
    expect(projected[0]?.payload).toMatchObject({
      content: "hello",
      is_complete: false,
      agent_name: "worker-a",
      member_route_key: "worker-a",
      event_scope: "member_scoped",
    });
  });

  it("projects nested sub-team agent events with hierarchical route key", () => {
    const nestedEvent = new AgentTeamStreamEvent({
      team_id: "team-1",
      event_source_type: "SUB_TEAM",
      data: new SubTeamEventRebroadcastPayload({
        sub_team_node_name: "sub-team",
        sub_team_event: new AgentTeamStreamEvent({
          team_id: "sub-team-runtime",
          event_source_type: "AGENT",
          data: new AgentEventRebroadcastPayload({
            agent_name: "worker-b",
            agent_event: new StreamEvent({
              event_id: "evt-2",
              event_type: StreamEventType.ARTIFACT_UPDATED,
              agent_id: "agent-2",
              data: {
                artifact_id: "art-1",
                path: "/tmp/a.txt",
                type: "file",
                agent_id: "agent-2",
              },
            }),
          }),
        }),
      }),
    });

    const projected = projectRemoteExecutionEventsFromTeamEvent({ teamEvent: nestedEvent });
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      memberName: "sub-team/worker-b",
      eventType: "artifact_updated",
      agentId: "agent-2",
    });
    expect(projected[0]?.payload).toMatchObject({
      agent_name: "worker-b",
      member_route_key: "sub-team/worker-b",
      event_scope: "member_scoped",
    });
  });

  it("ignores non-member-scoped team stream events", () => {
    const projected = projectRemoteExecutionEventsFromTeamEvent({
      teamEvent: new AgentTeamStreamEvent({
        team_id: "team-1",
        event_source_type: "TEAM",
        data: new AgentTeamStatusUpdateData({
          new_status: "ready",
        }),
      }),
    });

    expect(projected).toEqual([]);
  });
});
