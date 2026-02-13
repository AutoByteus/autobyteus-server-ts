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
import { AgentTeamInstanceManager } from "../../agent-team-execution/services/agent-team-instance-manager.js";
import { AgentSession } from "./agent-session.js";
import { AgentSessionManager } from "./agent-session-manager.js";
import { getAgentStreamHandler } from "./agent-stream-handler.js";
import {
  ClientMessageType,
  createErrorMessage,
  ServerMessage,
  ServerMessageType,
} from "./models.js";
import { serializePayload } from "./payload-serialization.js";
import {
  getDefaultTeamCommandIngressService,
  getDefaultTeamEventAggregator,
} from "../../distributed/bootstrap/default-distributed-runtime-composition.js";
import {
  TeamCommandIngressService,
  type ToolApprovalToken,
} from "../../distributed/ingress/team-command-ingress-service.js";
import { TeamEventAggregator } from "../../distributed/event-aggregation/team-event-aggregator.js";

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
};

export type DistributedTeamStreamProjection = {
  teamRunId: string;
  runVersion: string | number;
  sequence: number;
  sourceNodeId: string;
  memberName: string | null;
  agentId: string | null;
  origin: "local" | "remote";
  eventType: string;
  payload: unknown;
  receivedAtIso: string;
};

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

const KNOWN_SERVER_MESSAGE_TYPES = new Set<string>(Object.values(ServerMessageType));

class AgentTeamSession extends AgentSession {
  get teamId(): string {
    return this.agentId;
  }
}

export class AgentTeamStreamHandler {
  private sessionManager: AgentSessionManager;
  private teamManager: AgentTeamInstanceManager;
  private teamCommandIngressService: TeamCommandIngressService;
  private teamEventAggregator: TeamEventAggregator;
  private activeTasks = new Map<string, Promise<void>>();
  private eventStreams = new Map<string, AgentTeamEventStream>();
  private connectionBySessionId = new Map<string, WebSocketConnection>();

  constructor(
    sessionManager: AgentSessionManager = new AgentSessionManager(AgentTeamSession),
    teamManager: AgentTeamInstanceManager = AgentTeamInstanceManager.getInstance(),
    teamCommandIngressService: TeamCommandIngressService = getDefaultTeamCommandIngressService(),
    teamEventAggregator: TeamEventAggregator = getDefaultTeamEventAggregator(),
  ) {
    this.sessionManager = sessionManager;
    this.teamManager = teamManager;
    this.teamCommandIngressService = teamCommandIngressService;
    this.teamEventAggregator = teamEventAggregator;
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
    this.connectionBySessionId.set(sessionId, connection);

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
    this.connectionBySessionId.delete(sessionId);
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

  publishDistributedEnvelopeToTeamStream(input: {
    teamId: string;
    projection: DistributedTeamStreamProjection;
  }): number {
    const message = this.createDistributedMessage(input.projection);
    const sessions = this.sessionManager.getSessionsForAgent(input.teamId);

    let publishedCount = 0;
    for (const session of sessions) {
      const connection = this.connectionBySessionId.get(session.sessionId);
      if (!connection) {
        continue;
      }
      try {
        connection.send(message.toJson());
        publishedCount += 1;
      } catch (error) {
        logger.error(`Error rebroadcasting distributed team event: ${String(error)}`);
      }
    }

    return publishedCount;
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
    const content = typeof payload.content === "string" ? payload.content : "";
    const targetMemberName =
      (typeof payload.target_member_name === "string" && payload.target_member_name) ||
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

    await this.teamCommandIngressService.dispatchUserMessage({
      teamId,
      userMessage,
      targetMemberName,
    });
  }

  private async handleToolApproval(
    teamId: string,
    payload: Record<string, unknown>,
    approved: boolean,
  ): Promise<void> {
    const token = AgentTeamStreamHandler.extractToolApprovalToken(payload);
    if (!token) {
      logger.warn("Team tool approval missing valid approval_token payload.");
      return;
    }
    const agentName =
      (typeof payload.agent_name === "string" && payload.agent_name.trim().length > 0
        ? payload.agent_name
        : null) ?? token.targetMemberName;
    const reason = typeof payload.reason === "string" ? payload.reason : null;
    await this.teamCommandIngressService.dispatchToolApproval({
      teamId,
      token,
      isApproved: approved,
      reason,
      agentName,
    });
  }

  convertTeamEvent(event: AgentTeamStreamEvent): ServerMessage {
    const sourceType = event.event_source_type;

    if (sourceType === "AGENT" && event.data instanceof AgentEventRebroadcastPayload) {
      const agentEvent = event.data.agent_event;
      const message = getAgentStreamHandler().convertStreamEvent(agentEvent);
      const basePayload =
        message.payload && typeof message.payload === "object" ? message.payload : {};
      const payload: Record<string, unknown> = {
        ...basePayload,
        agent_name: event.data.agent_name,
        ...(agentEvent.agent_id ? { agent_id: agentEvent.agent_id } : {}),
      };
      if (
        message.type === ServerMessageType.TOOL_APPROVAL_REQUESTED &&
        typeof payload.invocation_id === "string"
      ) {
        const approvalToken = this.teamCommandIngressService.issueToolApprovalTokenFromActiveRun({
          teamId: event.team_id,
          invocationId: payload.invocation_id,
          targetMemberName: event.data.agent_name,
        });
        if (approvalToken) {
          payload.approval_token = approvalToken;
        }
      }
      return this.attachTeamStreamEnvelope(
        event,
        new ServerMessage(message.type, payload),
        `AGENT:${String(agentEvent.event_type)}`,
      );
    }

    if (sourceType === "TEAM" && event.data instanceof AgentTeamStatusUpdateData) {
      return this.attachTeamStreamEnvelope(
        event,
        new ServerMessage(ServerMessageType.TEAM_STATUS, serializePayload(event.data)),
        "TEAM_STATUS",
      );
    }

    if (sourceType === "TASK_PLAN") {
      const payload = serializePayload(event.data as TaskPlanEventPayload);
      let eventType = "TASK_PLAN_EVENT";
      if (Array.isArray(payload.tasks)) {
        eventType = "TASKS_CREATED";
      } else if (typeof payload.task_id === "string") {
        eventType = "TASK_STATUS_UPDATED";
      }
      return this.attachTeamStreamEnvelope(
        event,
        new ServerMessage(ServerMessageType.TASK_PLAN_EVENT, {
          event_type: eventType,
          ...payload,
        }),
        `TASK_PLAN:${eventType}`,
      );
    }

    if (sourceType === "SUB_TEAM" && event.data instanceof SubTeamEventRebroadcastPayload) {
      const subTeamEvent = event.data.sub_team_event;
      if (subTeamEvent instanceof AgentTeamStreamEvent) {
        const message = this.convertTeamEvent(subTeamEvent);
        const basePayload =
          message.payload && typeof message.payload === "object" ? message.payload : {};
        return this.attachTeamStreamEnvelope(
          event,
          new ServerMessage(message.type, {
            ...basePayload,
            sub_team_node_name: event.data.sub_team_node_name,
          }),
          `SUB_TEAM:${String(subTeamEvent.event_source_type)}`,
        );
      }
    }

    return createErrorMessage("UNKNOWN_TEAM_EVENT", `Unmapped team event source: ${String(sourceType)}`);
  }

  private attachTeamStreamEnvelope(
    event: AgentTeamStreamEvent,
    message: ServerMessage,
    eventType: string,
  ): ServerMessage {
    const run = this.teamCommandIngressService.resolveActiveRun(event.team_id);
    if (!run) {
      return message;
    }

    const aggregatedEvent = this.teamEventAggregator.publishLocalEvent({
      teamRunId: run.teamRunId,
      runVersion: run.runVersion,
      sourceNodeId: run.hostNodeId,
      eventType,
      payload: message.payload,
    });
    const basePayload =
      message.payload && typeof message.payload === "object" ? message.payload : {};
    return new ServerMessage(message.type, {
      ...basePayload,
      team_stream_event_envelope: {
        team_run_id: aggregatedEvent.teamRunId,
        run_version: aggregatedEvent.runVersion,
        sequence: aggregatedEvent.sequence,
        source_node_id: aggregatedEvent.sourceNodeId,
        origin: aggregatedEvent.origin,
        event_type: aggregatedEvent.eventType,
        received_at: aggregatedEvent.receivedAtIso,
      },
    });
  }

  private createDistributedMessage(projection: DistributedTeamStreamProjection): ServerMessage {
    const messageType = AgentTeamStreamHandler.resolveDistributedMessageType(projection.eventType);
    const basePayload =
      projection.payload && typeof projection.payload === "object" && !Array.isArray(projection.payload)
        ? { ...(projection.payload as Record<string, unknown>) }
        : { value: projection.payload };
    const payload: Record<string, unknown> = {
      ...basePayload,
      ...(projection.memberName ? { agent_name: projection.memberName } : {}),
      ...(projection.agentId ? { agent_id: projection.agentId } : {}),
      team_stream_event_envelope: {
        team_run_id: projection.teamRunId,
        run_version: projection.runVersion,
        sequence: projection.sequence,
        source_node_id: projection.sourceNodeId,
        origin: projection.origin,
        event_type: projection.eventType,
        received_at: projection.receivedAtIso,
      },
    };

    if (
      messageType === ServerMessageType.SYSTEM_TASK_NOTIFICATION &&
      typeof payload.event_type !== "string"
    ) {
      payload.event_type = projection.eventType;
    }

    return new ServerMessage(messageType, payload);
  }

  private static resolveDistributedMessageType(eventType: string): ServerMessageType {
    const normalized = eventType.trim();
    if (KNOWN_SERVER_MESSAGE_TYPES.has(normalized)) {
      return normalized as ServerMessageType;
    }

    if (normalized.startsWith("AGENT:")) {
      const stripped = normalized.slice("AGENT:".length);
      if (KNOWN_SERVER_MESSAGE_TYPES.has(stripped)) {
        return stripped as ServerMessageType;
      }
    }

    return ServerMessageType.SYSTEM_TASK_NOTIFICATION;
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

  private static extractToolApprovalToken(payload: Record<string, unknown>): ToolApprovalToken | null {
    const rawToken = payload.approval_token;
    if (!rawToken || typeof rawToken !== "object") {
      return null;
    }
    const token = rawToken as Record<string, unknown>;
    const teamRunId =
      (typeof token.teamRunId === "string" && token.teamRunId) ||
      (typeof token.team_run_id === "string" && token.team_run_id) ||
      null;
    const runVersion =
      (typeof token.runVersion === "number" && token.runVersion) ||
      (typeof token.run_version === "number" && token.run_version) ||
      null;
    const invocationId =
      (typeof token.invocationId === "string" && token.invocationId) ||
      (typeof token.invocation_id === "string" && token.invocation_id) ||
      null;
    const invocationVersion =
      (typeof token.invocationVersion === "number" && token.invocationVersion) ||
      (typeof token.invocation_version === "number" && token.invocation_version) ||
      null;
    const targetMemberName =
      (typeof token.targetMemberName === "string" && token.targetMemberName) ||
      (typeof token.target_member_name === "string" && token.target_member_name) ||
      null;

    if (!teamRunId || !runVersion || !invocationId || !invocationVersion || !targetMemberName) {
      return null;
    }

    return {
      teamRunId,
      runVersion,
      invocationId,
      invocationVersion,
      targetMemberName,
    };
  }
}

let cachedAgentTeamStreamHandler: AgentTeamStreamHandler | null = null;

export const getAgentTeamStreamHandler = (): AgentTeamStreamHandler => {
  if (!cachedAgentTeamStreamHandler) {
    cachedAgentTeamStreamHandler = new AgentTeamStreamHandler();
  }
  return cachedAgentTeamStreamHandler;
};
