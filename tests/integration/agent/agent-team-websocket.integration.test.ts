import fastify from "fastify";
import websocket from "@fastify/websocket";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  AgentInputUserMessage,
  AgentEventRebroadcastPayload,
  AgentTeamStreamEvent,
  StreamEvent,
  StreamEventType,
} from "autobyteus-ts";
import { AgentTeamStreamHandler } from "../../../src/services/agent-streaming/agent-team-stream-handler.js";
import { AgentSessionManager } from "../../../src/services/agent-streaming/agent-session-manager.js";
import { registerAgentWebsocket } from "../../../src/api/websocket/agent.js";

class FakeTeamStream {
  private queue: Array<AgentTeamStreamEvent | null> = [];
  private waiters: Array<(value: AgentTeamStreamEvent | null) => void> = [];
  private closed = false;

  push(event: AgentTeamStreamEvent): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    this.queue.push(event);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(null);
    } else {
      this.queue.push(null);
    }
  }

  private async next(): Promise<AgentTeamStreamEvent | null> {
    if (this.queue.length > 0) {
      return this.queue.shift() ?? null;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async *allEvents(): AsyncGenerator<AgentTeamStreamEvent, void, unknown> {
    while (true) {
      const event = await this.next();
      if (!event) {
        break;
      }
      yield event;
    }
  }
}

class FakeTeam {
  teamId: string;
  messages: AgentInputUserMessage[] = [];
  approvals: Array<{ agentName: string; invocationId: string; approved: boolean; reason: string | null }> = [];
  lastTarget: string | null = null;

  constructor(teamId: string) {
    this.teamId = teamId;
  }

  async postMessage(message: AgentInputUserMessage, targetAgentName?: string | null): Promise<void> {
    this.lastTarget = targetAgentName ?? null;
    this.messages.push(message);
  }

  async postToolExecutionApproval(
    agentName: string,
    toolInvocationId: string,
    isApproved: boolean,
    reason?: string | null,
  ): Promise<void> {
    this.approvals.push({
      agentName,
      invocationId: toolInvocationId,
      approved: isApproved,
      reason: reason ?? null,
    });
  }
}

class FakeTeamManager {
  private team: FakeTeam;
  private stream: FakeTeamStream;

  constructor(team: FakeTeam, stream: FakeTeamStream) {
    this.team = team;
    this.stream = stream;
  }

  getTeamInstance(teamId: string): FakeTeam | null {
    return teamId === this.team.teamId ? this.team : null;
  }

  getTeamEventStream(teamId: string): FakeTeamStream | null {
    return teamId === this.team.teamId ? this.stream : null;
  }
}

const waitForMessage = (socket: WebSocket, timeoutMs: number = 2000): Promise<string> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket message")), timeoutMs);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });

const waitForCondition = async (fn: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
};

describe("Agent team websocket integration", () => {
  it("streams team events and routes client messages", async () => {
    const team = new FakeTeam("team-1");
    const stream = new FakeTeamStream();
    const manager = new FakeTeamManager(team, stream);
    const handler = new AgentTeamStreamHandler(new AgentSessionManager(), manager as unknown as any);

    const dummyAgentHandler = {
      connect: async () => null,
      handleMessage: async () => {},
      disconnect: async () => {},
    } as unknown as Parameters<typeof registerAgentWebsocket>[1];

    const app = fastify();
    await app.register(websocket);
    await registerAgentWebsocket(app, dummyAgentHandler, handler);

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const url = new URL(address);
    const baseUrl = `ws://${url.hostname}:${url.port}`;

    const socket = new WebSocket(`${baseUrl}/ws/agent-team/${team.teamId}`);
    const connectedPromise = waitForMessage(socket);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket open")), 2000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const connectedMessage = JSON.parse(await connectedPromise) as {
      type: string;
      payload: { team_id: string; session_id: string };
    };

    expect(connectedMessage.type).toBe("CONNECTED");
    expect(connectedMessage.payload.team_id).toBe(team.teamId);

    socket.send(
      JSON.stringify({
        type: "SEND_MESSAGE",
        payload: {
          content: "hello team",
          target_member_name: "alpha",
          context_file_paths: ["/tmp/info.txt"],
          image_urls: ["https://example.com/dog.png"],
        },
      }),
    );

    await waitForCondition(() => team.messages.length === 1);
    expect(team.messages[0].constructor?.name).toBe("AgentInputUserMessage");
    expect(team.messages[0].content).toBe("hello team");
    expect(team.messages[0].contextFiles?.length).toBe(2);
    expect(team.lastTarget).toBe("alpha");

    const agentMessagePromise = waitForMessage(socket);
    const agentEvent = new StreamEvent({
      event_type: StreamEventType.ASSISTANT_CHUNK,
      data: { content: "hi", is_complete: false },
      agent_id: "agent-42",
    });
    const teamEvent = new AgentTeamStreamEvent({
      team_id: team.teamId,
      event_source_type: "AGENT",
      data: new AgentEventRebroadcastPayload({ agent_name: "alpha", agent_event: agentEvent }),
    });
    stream.push(teamEvent);

    const agentMessage = JSON.parse(await agentMessagePromise) as {
      type: string;
      payload: { content?: string; agent_name?: string; agent_id?: string };
    };

    expect(agentMessage.type).toBe("ASSISTANT_CHUNK");
    expect(agentMessage.payload.content).toBe("hi");
    expect(agentMessage.payload.agent_name).toBe("alpha");
    expect(agentMessage.payload.agent_id).toBe("agent-42");

    socket.close();
    await app.close();
  });
});
