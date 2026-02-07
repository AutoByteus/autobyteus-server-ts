import { PromptService } from "./prompt-service.js";
import { Prompt } from "../domain/models.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
};

const DEFAULT_MARKETPLACE_HOST_URL = "https://api.autobyteus.com";

type MarketplacePrompt = {
  name?: string;
  category?: string;
  prompt_content?: string;
  description?: string;
  suitable_for_models?: string | null;
};

export class PromptSyncService {
  private promptService: PromptService;

  constructor(promptService: PromptService = PromptService.getInstance()) {
    this.promptService = promptService;
    logger.info(
      `PromptSyncService initialized. Marketplace URL will be determined from AUTOBYTEUS_MARKETPLACE_HOST or default to '${DEFAULT_MARKETPLACE_HOST_URL}'.`,
    );
  }

  get marketplaceHostUrl(): string {
    const envValue = process.env.AUTOBYTEUS_MARKETPLACE_HOST;
    return envValue !== undefined ? envValue : DEFAULT_MARKETPLACE_HOST_URL;
  }

  get syncLanguage(): string {
    return process.env.AUTOBYTEUS_PROMPT_SYNC_LANGUAGE ?? "en";
  }

  parseSuitableForModels(models: string | null | undefined): Set<string> {
    if (!models) {
      return new Set<string>();
    }
    return new Set(
      models
        .split(",")
        .map((model) => model.trim())
        .filter((model) => model.length > 0),
    );
  }

  modelsIntersect(modelsA: string | null | undefined, modelsB: string | null | undefined): boolean {
    if (!modelsA || !modelsB) {
      return false;
    }
    const setA = this.parseSuitableForModels(modelsA);
    const setB = this.parseSuitableForModels(modelsB);
    for (const model of setA) {
      if (setB.has(model)) {
        return true;
      }
    }
    return false;
  }

  async syncPrompts(): Promise<boolean> {
    const urlForSync = this.marketplaceHostUrl;
    const envHostConfigured = process.env.AUTOBYTEUS_MARKETPLACE_HOST;

    if (envHostConfigured !== undefined) {
      logger.info(
        `Prompt synchronization will use URL from AUTOBYTEUS_MARKETPLACE_HOST environment variable: '${urlForSync}'`,
      );
      if (!urlForSync) {
        logger.warn(
          "AUTOBYTEUS_MARKETPLACE_HOST is set to an empty string. Prompt synchronization will be skipped.",
        );
        return false;
      }
    } else {
      logger.info(
        `AUTOBYTEUS_MARKETPLACE_HOST not set. Using default marketplace URL for synchronization: '${urlForSync}'`,
      );
      if (!urlForSync) {
        logger.error(
          `Default marketplace URL ('${DEFAULT_MARKETPLACE_HOST_URL}') is empty. Synchronization skipped.`,
        );
        return false;
      }
    }

    try {
      const marketplacePrompts = await this.fetchMarketplacePrompts();
      if (marketplacePrompts === null) {
        logger.error("Failed to fetch prompts from marketplace. Aborting sync.");
        return false;
      }

      if (marketplacePrompts.length === 0) {
        logger.info(
          "No prompts to synchronize from marketplace (received empty list). Sync considered complete.",
        );
        return true;
      }

      const autobyteusPrompts = await this.promptService.getAllActivePrompts();
      const nameCategoryMap = new Map<string, Prompt[]>();
      for (const prompt of autobyteusPrompts) {
        const key = `${prompt.name.toLowerCase()}:${prompt.category.toLowerCase()}`;
        const existing = nameCategoryMap.get(key) ?? [];
        existing.push(prompt);
        nameCategoryMap.set(key, existing);
      }

      let syncCount = 0;
      let createCount = 0;
      let skippedCount = 0;

      for (const marketplacePrompt of marketplacePrompts) {
        if (
          !marketplacePrompt.name ||
          !marketplacePrompt.category ||
          !marketplacePrompt.prompt_content
        ) {
          logger.warn(
            `Skipping marketplace prompt due to missing required fields ('name', 'category', 'prompt_content'). Prompt name: ${marketplacePrompt.name ?? "N/A"}. Received keys: ${Object.keys(
              marketplacePrompt,
            ).join(", ")}`,
          );
          skippedCount += 1;
          continue;
        }

        const promptKey = `${marketplacePrompt.name.toLowerCase()}:${marketplacePrompt.category.toLowerCase()}`;
        const marketplaceModels = marketplacePrompt.suitable_for_models ?? "";
        const existingPrompts = nameCategoryMap.get(promptKey) ?? [];
        let promptUpdated = false;

        for (const existingPrompt of existingPrompts) {
          if (this.modelsIntersect(existingPrompt.suitableForModels, marketplaceModels)) {
            if (
              existingPrompt.promptContent !== marketplacePrompt.prompt_content ||
              existingPrompt.suitableForModels !== marketplaceModels
            ) {
              await this.updateExistingPrompt(existingPrompt, marketplacePrompt);
              syncCount += 1;
              logger.info(
                `Updated prompt with intersecting models: ${promptKey} (id: ${existingPrompt.id ?? "N/A"})`,
              );
            } else {
              logger.debug(
                `No content or model changes for intersecting prompt: ${promptKey} (id: ${existingPrompt.id ?? "N/A"})`,
              );
              skippedCount += 1;
            }
            promptUpdated = true;
            break;
          }
        }

        if (!promptUpdated) {
          await this.createNewPrompt(marketplacePrompt);
          createCount += 1;
          logger.info(`Created new prompt (no model intersection): ${promptKey}`);
        }
      }

      logger.info(
        `Prompt synchronization completed: ${syncCount} updated, ${createCount} created, ${skippedCount} skipped/unchanged.`,
      );
      return true;
    } catch (error) {
      logger.error(`Failed to synchronize prompts: ${String(error)}`);
      return false;
    }
  }

  private async fetchMarketplacePrompts(): Promise<MarketplacePrompt[] | null> {
    const marketplaceUrl = this.marketplaceHostUrl;
    if (!marketplaceUrl) {
      logger.error("Marketplace host URL is empty. Cannot fetch prompts.");
      return null;
    }

    if (
      !marketplaceUrl.startsWith("http://") &&
      !marketplaceUrl.startsWith("https://")
    ) {
      logger.warn(
        `Marketplace URL ('${marketplaceUrl}') does not start with http:// or https://. This may cause issues with the request.`,
      );
    }

    const endpoint = new URL("/rest/prompts", marketplaceUrl);
    endpoint.searchParams.set("language", this.syncLanguage);

    logger.info(
      `Fetching active prompts from marketplace: ${endpoint.toString()} (language: ${this.syncLanguage})`,
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(endpoint.toString(), { signal: controller.signal });
      if (!response.ok) {
        logger.error(`Marketplace responded with status ${response.status}`);
        const text = await response.text();
        logger.error(`Marketplace error response: ${text.slice(0, 500)}`);
        return null;
      }

      const data = (await response.json()) as { prompts?: MarketplacePrompt[]; count?: number };
      const prompts = data.prompts ?? [];
      const count = data.count ?? prompts.length;

      logger.info(`Retrieved ${count} prompts from marketplace in ${this.syncLanguage} language.`);
      if (prompts.length > 0) {
        logger.debug(`First prompt structure received: ${Object.keys(prompts[0] ?? {}).join(", ")}`);
      }

      return prompts;
    } catch (error: any) {
      if (error?.name === "AbortError") {
        logger.error(`Timeout occurred while fetching prompts from ${endpoint.toString()}`);
      } else {
        logger.error(
          `Failed to fetch prompts from marketplace (${endpoint.toString()}): ${String(error)}`,
        );
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async updateExistingPrompt(
    existingPrompt: Prompt,
    marketplacePrompt: MarketplacePrompt,
  ): Promise<void> {
    try {
      logger.info(
        `Updating prompt in-place: ${existingPrompt.name} (category: ${existingPrompt.category}, id: ${existingPrompt.id ?? "N/A"})`,
      );

      const updated = await this.promptService.updatePrompt({
        promptId: existingPrompt.id ?? "",
        promptContent: marketplacePrompt.prompt_content ?? "",
        suitableForModels: marketplacePrompt.suitable_for_models ?? null,
      });

      if (updated) {
        logger.info(
          `Successfully updated prompt: ${existingPrompt.name} (category: ${existingPrompt.category}, id: ${existingPrompt.id ?? "N/A"})`,
        );
      } else {
        logger.error(
          `Failed to update prompt ${existingPrompt.name} (id: ${existingPrompt.id ?? "N/A"})`,
        );
      }
    } catch (error) {
      logger.error(
        `Failed to update prompt ${existingPrompt.name} (id: ${existingPrompt.id ?? "N/A"}): ${String(error)}`,
      );
    }
  }

  private async createNewPrompt(marketplacePrompt: MarketplacePrompt): Promise<void> {
    try {
      if (!marketplacePrompt.name || !marketplacePrompt.category || !marketplacePrompt.prompt_content) {
        throw new Error("Marketplace prompt missing required fields.");
      }
      logger.info(
        `Creating new prompt: ${marketplacePrompt.name} (category: ${marketplacePrompt.category})`,
      );
      const created = await this.promptService.createPrompt({
        name: marketplacePrompt.name,
        category: marketplacePrompt.category,
        promptContent: marketplacePrompt.prompt_content,
        description: marketplacePrompt.description ?? null,
        suitableForModels: marketplacePrompt.suitable_for_models ?? null,
      });
      logger.info(
        `Successfully created new prompt: ${created.name} (category: ${created.category}, id: ${created.id ?? "N/A"})`,
      );
    } catch (error) {
      logger.error(
        `Failed to create prompt ${marketplacePrompt.name ?? "unknown"}: ${String(error)}`,
      );
    }
  }
}

let cachedPromptSyncService: PromptSyncService | null = null;

export const getPromptSyncService = (): PromptSyncService => {
  if (!cachedPromptSyncService) {
    cachedPromptSyncService = new PromptSyncService();
  }
  return cachedPromptSyncService;
};
