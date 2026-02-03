import fs from "node:fs";
import path from "node:path";
import { BaseToolInvocationPreprocessor } from "autobyteus-ts";
import type { AgentContext } from "autobyteus-ts";
import type { ToolInvocation } from "autobyteus-ts/agent/tool-invocation.js";
import { MediaStorageService } from "../../../services/media-storage-service.js";
import { FileSystemWorkspace } from "../../../workspaces/filesystem-workspace.js";

const logger = {
  debug: (...args: unknown[]) => console.debug(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export class MediaInputPathToUrlPreprocessor extends BaseToolInvocationPreprocessor {
  static TARGET_TOOLS = new Set(["generate_image", "edit_image", "generate_speech"]);

  private mediaStorage: MediaStorageService;

  constructor() {
    super();
    this.mediaStorage = new MediaStorageService();
    logger.debug("MediaInputPathToUrlPreprocessor initialized.");
  }

  static override getName(): string {
    return "MediaInputPathToUrlPreprocessor";
  }

  static override getOrder(): number {
    return 50;
  }

  static override isMandatory(): boolean {
    return true;
  }

  private isRpaModel(modelName?: string | null): boolean {
    if (!modelName) {
      return false;
    }
    return modelName.toLowerCase().includes("rpa");
  }

  private modelIsRpaForTool(toolName: string): boolean {
    const envVarMap: Record<string, string> = {
      generate_image: "DEFAULT_IMAGE_GENERATION_MODEL",
      edit_image: "DEFAULT_IMAGE_EDIT_MODEL",
      generate_speech: "DEFAULT_SPEECH_GENERATION_MODEL",
    };

    const envVar = envVarMap[toolName];
    if (!envVar) {
      return false;
    }

    const configured = process.env[envVar] ?? "";
    return this.isRpaModel(configured);
  }

  private isUrl(value: string): boolean {
    return (
      value.startsWith("http://") ||
      value.startsWith("https://") ||
      value.startsWith("data:")
    );
  }

  private async normalizeList(
    items: string[],
    workspace: AgentContext["workspace"],
    agentId: string,
  ): Promise<string[]> {
    const normalized: string[] = [];

    for (const entryRaw of items) {
      const entry = entryRaw.trim();
      if (!entry) {
        continue;
      }
      if (this.isUrl(entry)) {
        normalized.push(entry);
        continue;
      }

      let resolvedPath: string | null = null;
      if (path.isAbsolute(entry)) {
        resolvedPath = entry;
      } else if (workspace instanceof FileSystemWorkspace) {
        try {
          resolvedPath = workspace.getAbsolutePath(entry);
        } catch (error) {
          logger.warn(
            `Agent '${agentId}': unable to resolve relative path '${entry}': ${String(error)}`,
          );
          continue;
        }
      } else {
        logger.warn(
          `Agent '${agentId}': no workspace to resolve relative path '${entry}'. Skipping.`,
        );
        continue;
      }

      if (!resolvedPath || !fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        logger.warn(
          `Agent '${agentId}': path '${resolvedPath ?? entry}' is not a file. Skipping.`,
        );
        continue;
      }

      try {
        const url = await this.mediaStorage.ingestLocalFileForContext(resolvedPath);
        normalized.push(url);
      } catch (error) {
        logger.error(
          `Agent '${agentId}': failed to ingest path '${resolvedPath}': ${String(error)}`,
        );
      }
    }

    return normalized;
  }

  async process(invocation: ToolInvocation, context: AgentContext): Promise<ToolInvocation> {
    const toolName = invocation.name ?? "";
    if (!MediaInputPathToUrlPreprocessor.TARGET_TOOLS.has(toolName)) {
      return invocation;
    }

    if (!this.modelIsRpaForTool(toolName)) {
      return invocation;
    }

    const args = (invocation.arguments ?? {}) as Record<string, unknown>;
    const agentId = context.agentId;
    const workspace = context.workspace;

    const imagesVal = args["input_images"];
    if (imagesVal) {
      let items: string[] = [];
      if (typeof imagesVal === "string") {
        items = imagesVal.split(",").map((entry) => entry.trim()).filter(Boolean);
      } else if (Array.isArray(imagesVal)) {
        items = imagesVal.filter((entry) => typeof entry === "string") as string[];
      } else {
        logger.warn(
          `Agent '${agentId}': input_images has unsupported type ${typeof imagesVal}; skipping normalization.`,
        );
      }

      const normalized = await this.normalizeList(items, workspace, agentId);
      if (normalized.length) {
        args["input_images"] = normalized.join(",");
      }
    }

    const maskVal = args["mask_image"];
    if (maskVal && typeof maskVal === "string" && !this.isUrl(maskVal)) {
      const maskList = await this.normalizeList([maskVal], workspace, agentId);
      if (maskList.length) {
        args["mask_image"] = maskList[0];
      }
    }

    invocation.arguments = args;
    return invocation;
  }
}
