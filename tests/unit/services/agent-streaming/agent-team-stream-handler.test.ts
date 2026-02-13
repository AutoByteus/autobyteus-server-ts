import { describe, expect, it } from "vitest";
import {
  AgentEventRebroadcastPayload,
  AgentTeamStreamEvent,
  StreamEventType,
} from "autobyteus-ts";
import { AgentTeamStreamHandler } from "../../../../src/services/agent-streaming/agent-team-stream-handler.js";
import { ServerMessageType } from "../../../../src/services/agent-streaming/models.js";
import { TeamEventAggregator } from "../../../../src/distributed/event-aggregation/team-event-aggregator.js";

describe("AgentTeamStreamHandler", () => {
  it("rebroadcasts agent lifecycle events with member context", () => {
    const ingress = {
      issueToolApprovalTokenFromActiveRun: () => null,
      resolveActiveRun: () => null,
    } as any;
    const handler = new AgentTeamStreamHandler(
      undefined,
      {
        getTeamInstance: () => null,
        getTeamEventStream: () => null,
      } as any,
      ingress,
      new TeamEventAggregator(),
    );

    const teamEvent = new AgentTeamStreamEvent({
      team_id: "team-1",
      event_source_type: "AGENT",
      data: new AgentEventRebroadcastPayload({
        agent_name: "worker-a",
        agent_event: {
          event_type: StreamEventType.TOOL_EXECUTION_SUCCEEDED,
          data: { invocation_id: "inv-1", tool_name: "read_file", result: { ok: true } },
          agent_id: "agent-xyz",
        },
      }),
    });

    const message = handler.convertTeamEvent(teamEvent);
    expect(message.type).toBe(ServerMessageType.TOOL_EXECUTION_SUCCEEDED);
    expect(message.payload.invocation_id).toBe("inv-1");
    expect(message.payload.agent_name).toBe("worker-a");
    expect(message.payload.agent_id).toBe("agent-xyz");
  });

  it("attaches tool approval token and stream envelope metadata for team events", () => {
    const ingress = {
      issueToolApprovalTokenFromActiveRun: () => ({
        teamRunId: "run-1",
        runVersion: 2,
        invocationId: "inv-2",
        invocationVersion: 1,
        targetMemberName: "worker-a",
      }),
      resolveActiveRun: () => ({
        teamId: "team-1",
        teamRunId: "run-1",
        runVersion: 2,
        hostNodeId: "node-host",
      }),
    } as any;
    const handler = new AgentTeamStreamHandler(
      undefined,
      {
        getTeamInstance: () => null,
        getTeamEventStream: () => null,
      } as any,
      ingress,
      new TeamEventAggregator(),
    );

    const teamEvent = new AgentTeamStreamEvent({
      team_id: "team-1",
      event_source_type: "AGENT",
      data: new AgentEventRebroadcastPayload({
        agent_name: "worker-a",
        agent_event: {
          event_type: StreamEventType.TOOL_APPROVAL_REQUESTED,
          data: { invocation_id: "inv-2", tool_name: "run_bash", arguments: { command: "pwd" } },
          agent_id: "agent-abc",
        },
      }),
    });

    const message = handler.convertTeamEvent(teamEvent);
    expect(message.type).toBe(ServerMessageType.TOOL_APPROVAL_REQUESTED);
    expect(message.payload.approval_token).toMatchObject({
      teamRunId: "run-1",
      runVersion: 2,
      invocationId: "inv-2",
      targetMemberName: "worker-a",
    });
    expect(message.payload.team_stream_event_envelope).toMatchObject({
      team_run_id: "run-1",
      run_version: 2,
      source_node_id: "node-host",
      origin: "local",
    });
  });

  it("rebroadcasts remote distributed envelopes to active team sessions", async () => {
    const sent: string[] = [];
    const handler = new AgentTeamStreamHandler(
      undefined,
      {
        getTeamInstance: (teamId: string) => (teamId === "team-1" ? { teamId } : null),
        getTeamEventStream: (teamId: string) =>
          teamId === "team-1"
            ? {
                async *allEvents() {
                  return;
                },
                close: async () => undefined,
              }
            : null,
      } as any,
      {
        issueToolApprovalTokenFromActiveRun: () => null,
        resolveActiveRun: () => null,
      } as any,
      new TeamEventAggregator(),
    );

    const sessionId = await handler.connect(
      {
        send: (data) => sent.push(data),
        close: () => undefined,
      },
      "team-1",
    );
    expect(sessionId).toBeTruthy();

    const publishedCount = handler.publishDistributedEnvelopeToTeamStream({
      teamId: "team-1",
      projection: {
        teamRunId: "run-1",
        runVersion: 3,
        sequence: 9,
        sourceNodeId: "node-remote",
        memberName: "helper",
        agentId: "agent-remote-1",
        origin: "remote",
        eventType: "ASSISTANT_CHUNK",
        payload: { content: "hello from remote", is_complete: false },
        receivedAtIso: "2026-02-12T00:00:00.000Z",
      },
    });

    expect(publishedCount).toBe(1);
    const payload = JSON.parse(sent[1] ?? "{}");
    expect(payload.type).toBe("ASSISTANT_CHUNK");
    expect(payload.payload.agent_name).toBe("helper");
    expect(payload.payload.team_stream_event_envelope).toMatchObject({
      team_run_id: "run-1",
      run_version: 3,
      source_node_id: "node-remote",
      origin: "remote",
      sequence: 9,
    });

    await handler.disconnect(sessionId!);
  });
});
