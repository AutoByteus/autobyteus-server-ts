import fs from "node:fs/promises";
import path from "node:path";
import { AgentTeamInstanceManager } from "../../agent-team-execution/services/agent-team-instance-manager.js";
import { appConfigProvider } from "../../config/app-config-provider.js";
import {
  TeamRunHistoryItem,
  TeamRunIndexRow,
  TeamRunKnownStatus,
  TeamRunManifest,
} from "../domain/team-models.js";
import { TeamRunIndexStore } from "../store/team-run-index-store.js";
import { TeamRunManifestStore } from "../store/team-run-manifest-store.js";

const logger = {
  warn: (...args: unknown[]) => console.warn(...args),
};

const nowIso = (): string => new Date().toISOString();

const compactSummary = (value: string | null): string => {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
};

export interface TeamRunDeleteHistoryResult {
  success: boolean;
  message: string;
}

export interface TeamRunResumeConfig {
  teamId: string;
  isActive: boolean;
  manifest: TeamRunManifest;
}

export class TeamRunHistoryService {
  private readonly manifestStore: TeamRunManifestStore;
  private readonly indexStore: TeamRunIndexStore;
  private readonly teamInstanceManager: AgentTeamInstanceManager;

  constructor(
    memoryDir: string,
    options: {
      teamInstanceManager?: AgentTeamInstanceManager;
    } = {},
  ) {
    this.manifestStore = new TeamRunManifestStore(memoryDir);
    this.indexStore = new TeamRunIndexStore(memoryDir);
    this.teamInstanceManager = options.teamInstanceManager ?? AgentTeamInstanceManager.getInstance();
  }

  async listTeamRunHistory(): Promise<TeamRunHistoryItem[]> {
    let rows = await this.indexStore.listRows();
    if (rows.length === 0) {
      rows = await this.rebuildIndexFromDisk();
    }

    const items: TeamRunHistoryItem[] = [];
    for (const row of rows) {
      const manifest = await this.manifestStore.readManifest(row.teamId);
      if (!manifest) {
        continue;
      }
      const isActive = this.teamInstanceManager.getTeamInstance(row.teamId) !== null;
      items.push({
        teamId: row.teamId,
        teamDefinitionId: row.teamDefinitionId,
        teamDefinitionName: row.teamDefinitionName,
        summary: row.summary,
        lastActivityAt: row.lastActivityAt,
        lastKnownStatus: isActive ? "ACTIVE" : row.lastKnownStatus,
        deleteLifecycle: row.deleteLifecycle,
        isActive,
        members: manifest.memberBindings.map((binding) => ({
          memberRouteKey: binding.memberRouteKey,
          memberName: binding.memberName,
          memberAgentId: binding.memberAgentId,
          agentDefinitionId: binding.agentDefinitionId,
          llmModelIdentifier: binding.llmModelIdentifier,
          autoExecuteTools: binding.autoExecuteTools,
          llmConfig: binding.llmConfig ?? null,
          workspaceRootPath: binding.workspaceRootPath,
          hostNodeId: binding.hostNodeId,
        })),
      });
    }

    items.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    return items;
  }

  async upsertTeamRunHistoryRow(options: {
    teamId: string;
    manifest: TeamRunManifest;
    summary: string;
    lastKnownStatus?: TeamRunKnownStatus;
    lastActivityAt?: string;
  }): Promise<void> {
    const row: TeamRunIndexRow = {
      teamId: options.teamId,
      teamDefinitionId: options.manifest.teamDefinitionId,
      teamDefinitionName: options.manifest.teamDefinitionName,
      summary: compactSummary(options.summary),
      lastActivityAt: options.lastActivityAt ?? nowIso(),
      lastKnownStatus: options.lastKnownStatus ?? "ACTIVE",
      deleteLifecycle: "READY",
    };
    await this.manifestStore.writeManifest(options.teamId, options.manifest);
    await this.indexStore.upsertRow(row);
  }

  async onTeamEvent(teamId: string, options: { status?: TeamRunKnownStatus; summary?: string } = {}): Promise<void> {
    const existing = await this.indexStore.getRow(teamId);
    if (!existing) {
      const manifest = await this.manifestStore.readManifest(teamId);
      if (!manifest) {
        return;
      }
      await this.indexStore.upsertRow({
        teamId,
        teamDefinitionId: manifest.teamDefinitionId,
        teamDefinitionName: manifest.teamDefinitionName,
        summary: compactSummary(options.summary ?? ""),
        lastActivityAt: nowIso(),
        lastKnownStatus: options.status ?? "ACTIVE",
        deleteLifecycle: "READY",
      });
      return;
    }
    await this.indexStore.updateRow(teamId, {
      lastActivityAt: nowIso(),
      summary: options.summary !== undefined ? compactSummary(options.summary) : existing.summary,
      lastKnownStatus: options.status ?? existing.lastKnownStatus,
    });
  }

  async onTeamTerminated(teamId: string): Promise<void> {
    await this.indexStore.updateRow(teamId, {
      lastKnownStatus: "IDLE",
      lastActivityAt: nowIso(),
    });
  }

  async getTeamRunResumeConfig(teamId: string): Promise<TeamRunResumeConfig> {
    const manifest = await this.manifestStore.readManifest(teamId);
    if (!manifest) {
      throw new Error(`Team run manifest not found for '${teamId}'.`);
    }
    return {
      teamId,
      isActive: this.teamInstanceManager.getTeamInstance(teamId) !== null,
      manifest,
    };
  }

  async deleteTeamRunHistory(teamId: string): Promise<TeamRunDeleteHistoryResult> {
    const normalizedTeamId = teamId.trim();
    if (!normalizedTeamId) {
      return {
        success: false,
        message: "Team ID is required.",
      };
    }
    if (this.teamInstanceManager.getTeamInstance(normalizedTeamId)) {
      return {
        success: false,
        message: "Team run is active. Terminate it before deleting history.",
      };
    }

    const safeTarget = this.resolveSafeTeamDirectory(normalizedTeamId);
    if (!safeTarget) {
      return {
        success: false,
        message: "Invalid team ID path.",
      };
    }

    try {
      await fs.rm(safeTarget, { recursive: true, force: true });
      await this.indexStore.removeRow(normalizedTeamId);
      return {
        success: true,
        message: `Team run '${normalizedTeamId}' deleted permanently.`,
      };
    } catch (error) {
      logger.warn(`Failed to delete team run history '${normalizedTeamId}': ${String(error)}`);
      return {
        success: false,
        message: `Failed to delete team run history '${normalizedTeamId}'.`,
      };
    }
  }

  async rebuildIndexFromDisk(): Promise<TeamRunIndexRow[]> {
    const teamIds = await this.manifestStore.listTeamIds();
    const rows: TeamRunIndexRow[] = [];
    for (const teamId of teamIds) {
      const manifest = await this.manifestStore.readManifest(teamId);
      if (!manifest) {
        continue;
      }
      rows.push({
        teamId,
        teamDefinitionId: manifest.teamDefinitionId,
        teamDefinitionName: manifest.teamDefinitionName,
        summary: "",
        lastActivityAt: manifest.updatedAt || manifest.createdAt || nowIso(),
        lastKnownStatus: this.teamInstanceManager.getTeamInstance(teamId) ? "ACTIVE" : "IDLE",
        deleteLifecycle: "READY",
      });
    }
    await this.indexStore.writeIndex({
      version: 1,
      rows,
    });
    return rows;
  }

  private resolveSafeTeamDirectory(teamId: string): string | null {
    const teamsRoot = path.resolve(this.manifestStore.getTeamDirPath(""));
    const targetPath = path.resolve(this.manifestStore.getTeamDirPath(teamId));
    if (targetPath === teamsRoot) {
      return null;
    }
    const targetWithinRoot = targetPath.startsWith(`${teamsRoot}${path.sep}`);
    if (!targetWithinRoot) {
      return null;
    }
    return targetPath;
  }
}

let cachedTeamRunHistoryService: TeamRunHistoryService | null = null;

export const getTeamRunHistoryService = (): TeamRunHistoryService => {
  if (!cachedTeamRunHistoryService) {
    cachedTeamRunHistoryService = new TeamRunHistoryService(appConfigProvider.config.getMemoryDir());
  }
  return cachedTeamRunHistoryService;
};
