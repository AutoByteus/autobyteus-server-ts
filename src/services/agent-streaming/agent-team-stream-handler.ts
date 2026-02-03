import { randomUUID } from "node:crypto";
import {
  AgentInputUserMessage,
  ContextFile,
  ContextFileType,
  AgentTeamEventStream,
  AgentTeamStreamEvent,
  AgentEventRebroadcastPayload,
  AgentTeamStatusUpdateData,
  SubTeamEventRebroadcastPayload,
  type TaskPlanEventPayload,
} from "autobyteus-ts";
import { agentTeamInstanceManager, AgentTeamInstanceManager } from "../../agent-team-execution/services/agent-team-instance-manager.js";
import { AgentSession } from "./agent-session.js";
import { AgentSessionManager } from "./agent-session-manager.js";
import { agentStreamHandler } from "./agent-stream-handler.js";
import {
  ClientMessageType,
  createErrorMessage,
  ServerMessage,
  ServerMessageType,
} from "./models.js";

export type WebSocketConnection = {
  send: (data: string) => void;
  close: (code?: number) => void;
};

type ClientMessage = {
  type?: string;
  payload?: Record<string, unknown>;
};

type TeamLike = {
  teamId: string;
  postMessage?: (message: AgentInputUserMessage, targetAgentName?: string | null) => Promise<void>;
  postToolExecutionApproval?: (
    agentName: string,
    toolInvocationId: string,
    isApproved: boolean,
    reason?: string | null,
  ) => Promise<void>;
};

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

const toPayload = (data: unknown): Record<string, unknown> => {
  if (!data || typeof data !== "object") {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  } catch {
    return data as Record<string, unknown>;
  }
};

class AgentTeamSession extends AgentSession {
  get teamId(): string {
    return this.agentId;
  }
}

export class AgentTeamStreamHandler {
  private sessionManager: AgentSessionManager;
  private teamManager: AgentTeamInstanceManager;
  private activeTasks = new Map<string, Promise<void>>();
  private eventStreams = new Map<string, AgentTeamEventStream>();

  constructor(
    sessionManager: AgentSessionManager = new AgentSessionManager(AgentTeamSession),
    teamManager: AgentTeamInstanceManager = agentTeamInstanceManager,
  ) {
    this.sessionManager = sessionManager;
    this.teamManager = teamManager;
  }

  async connect(connection: WebSocketConnection, teamId: string): Promise<string | null> {
    const team = this.teamManager.getTeamInstance(teamId) as TeamLike | null;
    if (!team) {
      const errorMsg = createErrorMessage("TEAM_NOT_FOUND", `Team '${teamId}' not found`);
      connection.send(errorMsg.toJson());
      connection.close(4004);
      return null;
    }

    const sessionId = randomUUID();
    try {
      const session = this.sessionManager.createSession(sessionId, teamId);
      session.connect();
    } catch (error) {
      logger.error(`Failed to create team session: ${String(error)}`);
      const errorMsg = createErrorMessage("SESSION_ERROR", String(error));
      connection.send(errorMsg.toJson());
      connection.close(1011);
      return null;
    }

    const eventStream = this.teamManager.getTeamEventStream(teamId);
    if (!eventStream) {
      const errorMsg = createErrorMessage("TEAM_STREAM_UNAVAILABLE", `Team '${teamId}' stream not available`);
      connection.send(errorMsg.toJson());
      connection.close(1011);
      return null;
    }
    this.eventStreams.set(sessionId, eventStream);

    const connectedMsg = new ServerMessage(ServerMessageType.CONNECTED, {
      team_id: teamId,
      session_id: sessionId,
    });
    connection.send(connectedMsg.toJson());

    const task = this.streamLoop(connection, teamId, sessionId);
    this.activeTasks.set(sessionId, task);

    logger.info(`Agent Team WebSocket connected: session=${sessionId}, team=${teamId}`);
    return sessionId;
  }

  async handleMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      logger.warn(`Message for unknown team session: ${sessionId}`);
      return;
    }

    try {
      const data = AgentTeamStreamHandler.parseMessage(message);
      const msgType = data.type;
      const payload = data.payload ?? {};

      if (msgType === ClientMessageType.SEND_MESSAGE) {
        await this.handleSendMessage(session.agentId, payload);
      } else if (msgType === ClientMessageType.STOP_GENERATION) {
        logger.info(`Stop generation requested for team ${session.agentId}`);
      } else if (msgType === ClientMessageType.APPROVE_TOOL) {
        await this.handleToolApproval(session.agentId, payload, true);
      } else if (msgType === ClientMessageType.DENY_TOOL) {
        await this.handleToolApproval(session.agentId, payload, false);
      } else {
        logger.warn(`Unknown message type: ${String(msgType)}`);
      }
    } catch (error) {
      logger.error(`Error handling team message for ${sessionId}: ${String(error)}`);
    }
  }

  async disconnect(sessionId: string): Promise<void> {
    const task = this.activeTasks.get(sessionId);
    this.activeTasks.delete(sessionId);

    const stream = this.eventStreams.get(sessionId);
    this.eventStreams.delete(sessionId);
    if (stream) {
      await stream.close();
    }

    this.sessionManager.closeSession(sessionId);

    if (task) {
      try {
        await task;
      } catch {
        // ignore
      }
    }

    logger.info(`Agent Team WebSocket disconnected: ${sessionId}`);
  }

  private async streamLoop(connection: WebSocketConnection, teamId: string, sessionId: string): Promise<void> {
    try {
      const eventStream = this.eventStreams.get(sessionId);
      if (!eventStream) {
        logger.error(`No event stream for team session ${sessionId}`);
        return;
      }

      for await (const event of eventStream.allEvents()) {
        try {
          const wsMessage = this.convertTeamEvent(event);
          connection.send(wsMessage.toJson());
        } catch (error) {
          logger.error(`Error sending team event to WebSocket: ${String(error)}`);
        }
      }
    } catch (error) {
      logger.error(`Error in team stream loop for ${sessionId}: ${String(error)}`);
    } finally {
      const stream = this.eventStreams.get(sessionId);
      if (stream) {
        await stream.close();
        this.eventStreams.delete(sessionId);
      }
    }
  }

  private async handleSendMessage(teamId: string, payload: Record<string, unknown>): Promise<void> {
    const team = this.teamManager.getTeamInstance(teamId) as TeamLike | null;
    if (!team?.postMessage) {
      logger.warn(`Team ${teamId} not found for send_message`);
      return;
    }

    const content = typeof payload.content === "string" ? payload.content : "";
    const targetMemberName =
      (typeof payload.target_member_name === "string" && payload.target_member_name) ||
      (typeof payload.target_agent_name === "string" && payload.target_agent_name) ||
      null;

    const contextFilePaths =
      (payload.context_file_paths as unknown[]) ?? (payload.contextFilePaths as unknown[]) ?? [];
    const imageUrls = (payload.image_urls as unknown[]) ?? (payload.imageUrls as unknown[]) ?? [];

    const contextFiles: ContextFile[] = [];
    for (const path of contextFilePaths) {
      if (typeof path === "string" && path.length > 0) {
        contextFiles.push(new ContextFile(path));
      }
    }
    for (const url of imageUrls) {
      if (typeof url === "string" && url.length > 0) {
        contextFiles.push(new ContextFile(url, ContextFileType.IMAGE));
      }
    }

    const contextPayload = contextFiles.map((file) => file.toDict());
    const userMessage = AgentInputUserMessage.fromDict({
      content,
      context_files: contextPayload.length > 0 ? contextPayload : null,
    });

    await team.postMessage(userMessage, targetMemberName);
  }

  private async handleToolApproval(
    teamId: string,
    payload: Record<string, unknown>,
    approved: boolean,
  ): Promise<void> {
    const team = this.teamManager.getTeamInstance(teamId) as TeamLike | null;
    if (!team?.postToolExecutionApproval) {
      logger.warn(`Team ${teamId} not found for tool approval`);
      return;
    }

    const invocationId = payload.invocation_id;
    if (typeof invocationId !== "string" || invocationId.length === 0) {
      logger.warn("Team tool approval missing invocation_id");
      return;
    }

    const agentName =
      (typeof payload.agent_name === "string" && payload.agent_name) ||
      (typeof payload.target_member_name === "string" && payload.target_member_name) ||
      (typeof payload.agent_id === "string" && payload.agent_id) ||
      null;

    if (!agentName) {
      logger.warn("Team tool approval missing agent_name/agent_id; cannot route approval");
      return;
    }

    const reason = typeof payload.reason === "string" ? payload.reason : null;
    await team.postToolExecutionApproval(agentName, invocationId, approved, reason);
  }

  convertTeamEvent(event: AgentTeamStreamEvent): ServerMessage {
    const sourceType = event.event_source_type;

    if (sourceType === "AGENT" && event.data instanceof AgentEventRebroadcastPayload) {
      const agentEvent = event.data.agent_event;
      const message = agentStreamHandler.convertStreamEvent(agentEvent);
      const basePayload =
        message.payload && typeof message.payload === "object" ? message.payload : {};
      return new ServerMessage(message.type, {
        ...basePayload,
        agent_name: event.data.agent_name,
        ...(agentEvent.agent_id ? { agent_id: agentEvent.agent_id } : {}),
      });
    }

    if (sourceType === "TEAM" && event.data instanceof AgentTeamStatusUpdateData) {
      return new ServerMessage(ServerMessageType.TEAM_STATUS, toPayload(event.data));
    }

    if (sourceType === "TASK_PLAN") {
      const payload = toPayload(event.data as TaskPlanEventPayload);
      let eventType = "TASK_PLAN_EVENT";
      if (Array.isArray(payload.tasks)) {
        eventType = "TASKS_CREATED";
      } else if (typeof payload.task_id === "string") {
        eventType = "TASK_STATUS_UPDATED";
      }
      return new ServerMessage(ServerMessageType.TASK_PLAN_EVENT, {
        event_type: eventType,
        ...payload,
      });
    }

    if (sourceType === "SUB_TEAM" && event.data instanceof SubTeamEventRebroadcastPayload) {
      const subTeamEvent = event.data.sub_team_event;
      if (subTeamEvent instanceof AgentTeamStreamEvent) {
        const message = this.convertTeamEvent(subTeamEvent);
        const basePayload =
          message.payload && typeof message.payload === "object" ? message.payload : {};
        return new ServerMessage(message.type, {
          ...basePayload,
          sub_team_node_name: event.data.sub_team_node_name,
        });
      }
    }

    return createErrorMessage("UNKNOWN_TEAM_EVENT", `Unmapped team event source: ${String(sourceType)}`);
  }

  static parseMessage(raw: string): ClientMessage {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON: ${String(error)}`);
    }

    if (!data || typeof data !== "object" || !("type" in data)) {
      throw new Error("Message missing 'type' field");
    }

    return data as ClientMessage;
  }
}

export const agentTeamStreamHandler = new AgentTeamStreamHandler();
