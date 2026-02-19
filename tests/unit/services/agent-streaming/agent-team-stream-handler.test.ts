import { describe, expect, it, vi } from "vitest";
import {
  AgentEventRebroadcastPayload,
  AgentTeamStatusUpdateData,
  AgentTeamStreamEvent,
  SubTeamEventRebroadcastPayload,
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
    if (!message) {
      throw new Error("Expected rebroadcasted agent lifecycle event to produce a websocket message");
    }
    expect(message.type).toBe(ServerMessageType.TOOL_EXECUTION_SUCCEEDED);
    expect(message.payload.invocation_id).toBe("inv-1");
    expect(message.payload.agent_name).toBe("worker-a");
    expect(message.payload.agent_id).toBe("agent-xyz");
    expect(message.payload.member_route_key).toBe("worker-a");
    expect(message.payload.event_scope).toBe("member_scoped");
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
    if (!message) {
      throw new Error("Expected tool approval event to produce a websocket message");
    }
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
    expect(message.payload.event_scope).toBe("member_scoped");
  });

  it("publishes stream activity to team run history sink", () => {
    const activitySink = {
      onTeamStreamMessage: expect.any(Function),
    } as any;
    activitySink.onTeamStreamMessage = vi.fn();
    const ingress = {
      issueToolApprovalTokenFromActiveRun: () => null,
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
      activitySink,
    );

    const teamEvent = new AgentTeamStreamEvent({
      team_id: "team-1",
      event_source_type: "TEAM",
      data: new AgentTeamStatusUpdateData({
        new_status: "idle",
      }),
    });
    handler.convertTeamEvent(teamEvent);

    expect(activitySink.onTeamStreamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        messageType: ServerMessageType.TEAM_STATUS,
      }),
    );
  });

  it("propagates hierarchical member route key for sub-team member events", () => {
    const handler = new AgentTeamStreamHandler(
      undefined,
      {
        getTeamInstance: () => null,
        getTeamEventStream: () => null,
      } as any,
      {
        issueToolApprovalTokenFromActiveRun: () => null,
        resolveActiveRun: () => null,
      } as any,
      new TeamEventAggregator(),
    );

    const subTeamAgentEvent = new AgentTeamStreamEvent({
      team_id: "team-1",
      event_source_type: "AGENT",
      data: new AgentEventRebroadcastPayload({
        agent_name: "worker-b",
        agent_event: {
          event_type: StreamEventType.AGENT_STATUS_UPDATED,
          data: { new_status: "processing" },
          agent_id: "agent-b",
        },
      }),
    });

    const teamEvent = new AgentTeamStreamEvent({
      team_id: "team-1",
      event_source_type: "SUB_TEAM",
      data: new SubTeamEventRebroadcastPayload({
        sub_team_node_name: "sub-team-1",
        sub_team_event: subTeamAgentEvent,
      }),
    });

    const message = handler.convertTeamEvent(teamEvent);
    if (!message) {
      throw new Error("Expected sub-team member event to produce a websocket message");
    }
    expect(message.type).toBe(ServerMessageType.AGENT_STATUS);
    expect(message.payload.member_route_key).toBe("sub-team-1/worker-b");
    expect(message.payload.sub_team_node_name).toBe("sub-team-1");
  });

  it("drops deprecated remote assistant chunk envelopes", async () => {
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
        eventType: "AGENT:assistant_chunk",
        payload: { content: "hello from remote", is_complete: false },
        receivedAtIso: "2026-02-12T00:00:00.000Z",
      },
    });

    expect(publishedCount).toBe(0);
    expect(sent).toHaveLength(1); // CONNECTED only

    await handler.disconnect(sessionId!);
  });

  it("preserves payload leaf agent_name when distributed projection memberName is hierarchical route", async () => {
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

    handler.publishDistributedEnvelopeToTeamStream({
      teamId: "team-1",
      projection: {
        teamRunId: "run-2",
        runVersion: 4,
        sequence: 11,
        sourceNodeId: "node-remote",
        memberName: "sub-team/worker-b",
        agentId: "agent-remote-b",
        origin: "remote",
        eventType: "assistant_complete_response",
        payload: {
          content: "nested completion",
          agent_name: "worker-b",
          member_route_key: "sub-team/worker-b",
          event_scope: "member_scoped",
        },
        receivedAtIso: "2026-02-14T00:00:00.000Z",
      },
    });

    const payload = JSON.parse(sent[1] ?? "{}");
    expect(payload.type).toBe("ASSISTANT_COMPLETE");
    expect(payload.payload.agent_name).toBe("worker-b");
    expect(payload.payload.member_route_key).toBe("sub-team/worker-b");
    expect(payload.payload.agent_id).toBe("agent-remote-b");

    await handler.disconnect(sessionId!);
  });

  it("maps bare distributed segment_event payloads back to segment stream message types", async () => {
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

    handler.publishDistributedEnvelopeToTeamStream({
      teamId: "team-1",
      projection: {
        teamRunId: "run-3",
        runVersion: 1,
        sequence: 12,
        sourceNodeId: "node-remote",
        memberName: "student",
        agentId: "agent-student",
        origin: "remote",
        eventType: "segment_event",
        payload: {
          event_type: "SEGMENT_START",
          segment_type: "text",
          id: "seg-1",
          metadata: {},
        },
        receivedAtIso: "2026-02-18T00:00:00.000Z",
      },
    });

    const payload = JSON.parse(sent[1] ?? "{}");
    expect(payload.type).toBe("SEGMENT_START");
    expect(payload.payload.segment_type).toBe("text");
    expect(payload.payload.id).toBe("seg-1");
    expect(payload.payload.member_route_key).toBe("student");

    await handler.disconnect(sessionId!);
  });

  it("rejects distributed segment_event payloads missing canonical id", async () => {
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

    handler.publishDistributedEnvelopeToTeamStream({
      teamId: "team-1",
      projection: {
        teamRunId: "run-3",
        runVersion: 1,
        sequence: 12,
        sourceNodeId: "node-remote",
        memberName: "student",
        agentId: "agent-student",
        origin: "remote",
        eventType: "segment_event",
        payload: {
          event_type: "SEGMENT_START",
          segment_type: "text",
          segment_id: "seg-legacy",
          metadata: {},
        },
        receivedAtIso: "2026-02-18T00:00:00.000Z",
      },
    });

    const payload = JSON.parse(sent[1] ?? "{}");
    expect(payload.type).toBe("ERROR");
    expect(payload.payload.code).toBe("INVALID_DISTRIBUTED_SEGMENT_PAYLOAD");
    expect(payload.payload.distributed_event_type).toBe("segment_event");

    await handler.disconnect(sessionId!);
  });

  it("accepts canonical distributed segment_event payload fields for start/content events", async () => {
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

    handler.publishDistributedEnvelopeToTeamStream({
      teamId: "team-1",
      projection: {
        teamRunId: "run-3",
        runVersion: 1,
        sequence: 12,
        sourceNodeId: "node-remote",
        memberName: "student",
        agentId: "agent-student",
        origin: "remote",
        eventType: "segment_event",
        payload: {
          event_type: "SEGMENT_START",
          id: "seg-nested",
          segment_type: "tool_call",
          metadata: {
            tool_name: "send_message_to",
          },
        },
        receivedAtIso: "2026-02-18T00:00:00.000Z",
      },
    });

    handler.publishDistributedEnvelopeToTeamStream({
      teamId: "team-1",
      projection: {
        teamRunId: "run-3",
        runVersion: 1,
        sequence: 13,
        sourceNodeId: "node-remote",
        memberName: "student",
        agentId: "agent-student",
        origin: "remote",
        eventType: "segment_event",
        payload: {
          id: "seg-nested",
          delta: "hello",
        },
        receivedAtIso: "2026-02-18T00:00:01.000Z",
      },
    });

    const startMessage = JSON.parse(sent[1] ?? "{}");
    expect(startMessage.type).toBe("SEGMENT_START");
    expect(startMessage.payload.id).toBe("seg-nested");
    expect(startMessage.payload.segment_type).toBe("tool_call");
    expect(startMessage.payload.metadata).toEqual({ tool_name: "send_message_to" });

    const contentMessage = JSON.parse(sent[2] ?? "{}");
    expect(contentMessage.type).toBe("SEGMENT_CONTENT");
    expect(contentMessage.payload.id).toBe("seg-nested");
    expect(contentMessage.payload.delta).toBe("hello");

    await handler.disconnect(sessionId!);
  });

  it("treats internal notifier event names as unknown distributed event types", async () => {
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

    handler.publishDistributedEnvelopeToTeamStream({
      teamId: "team-1",
      projection: {
        teamRunId: "run-4",
        runVersion: 1,
        sequence: 13,
        sourceNodeId: "node-remote",
        memberName: "student",
        agentId: "agent-student",
        origin: "remote",
        eventType: "agent_data_assistant_complete_response",
        payload: {
          content: "I have one tool available.",
          agent_name: "student",
        },
        receivedAtIso: "2026-02-18T00:00:00.000Z",
      },
    });

    const payload = JSON.parse(sent[1] ?? "{}");
    expect(payload.type).toBe("ERROR");
    expect(payload.payload.code).toBe("UNKNOWN_DISTRIBUTED_EVENT_TYPE");
    expect(payload.payload.distributed_event_type).toBe("agent_data_assistant_complete_response");

    await handler.disconnect(sessionId!);
  });

  it("maps distributed error_event payloads to websocket ERROR messages", async () => {
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

    handler.publishDistributedEnvelopeToTeamStream({
      teamId: "team-1",
      projection: {
        teamRunId: "run-5",
        runVersion: 1,
        sequence: 14,
        sourceNodeId: "node-remote",
        memberName: "student",
        agentId: "agent-student",
        origin: "remote",
        eventType: "error_event",
        payload: {
          code: "OUTPUT_GENERATION_FAILED",
          message: "Model rejected prompt.",
        },
        receivedAtIso: "2026-02-18T00:00:00.000Z",
      },
    });

    const payload = JSON.parse(sent[1] ?? "{}");
    expect(payload.type).toBe("ERROR");
    expect(payload.payload.code).toBe("OUTPUT_GENERATION_FAILED");
    expect(payload.payload.message).toBe("Model rejected prompt.");
    expect(payload.payload.member_route_key).toBe("student");

    await handler.disconnect(sessionId!);
  });

  it("never coerces unknown distributed event types into system task notifications", async () => {
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

    handler.publishDistributedEnvelopeToTeamStream({
      teamId: "team-1",
      projection: {
        teamRunId: "run-5",
        runVersion: 1,
        sequence: 14,
        sourceNodeId: "node-remote",
        memberName: "student",
        agentId: "agent-student",
        origin: "remote",
        eventType: "unexpected_event_type",
        payload: {
          raw: true,
        },
        receivedAtIso: "2026-02-18T00:00:00.000Z",
      },
    });

    const payload = JSON.parse(sent[1] ?? "{}");
    expect(payload.type).toBe("ERROR");
    expect(payload.type).not.toBe("SYSTEM_TASK_NOTIFICATION");
    expect(payload.payload.code).toBe("UNKNOWN_DISTRIBUTED_EVENT_TYPE");
    expect(payload.payload.distributed_event_type).toBe("unexpected_event_type");

    await handler.disconnect(sessionId!);
  });
});
