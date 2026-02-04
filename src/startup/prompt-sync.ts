import { appConfigProvider } from "../config/app-config-provider.js";
import { getPromptSyncService } from "../prompt-engineering/services/prompt-sync-service.js";
import { getPromptLoader } from "../prompt-engineering/utils/prompt-loader.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

const truthyValues = new Set(["true", "1", "yes"]);

export async function runPromptSynchronization(): Promise<void> {
  const config = appConfigProvider.config;
  const syncEnabled = config.get("AUTOBYTEUS_PROMPT_SYNC_ON_STARTUP", "false") ?? "false";

  if (!truthyValues.has(syncEnabled.toLowerCase())) {
    logger.info(
      "Automatic prompt synchronization on startup is disabled by configuration. Skipping.",
    );
    return;
  }

  logger.info(
    "Background prompt synchronization has started. Attempting to sync prompts from marketplace...",
  );

  try {
    const syncSuccess = await getPromptSyncService().syncPrompts();
    if (syncSuccess) {
      getPromptLoader().invalidateCache();
      logger.info("Prompt synchronization finished successfully.");
      logger.info("Prompt template cache invalidated after successful synchronization.");
    } else {
      logger.warn(
        "Prompt synchronization finished with errors or was skipped. Check previous logs for details.",
      );
    }
  } catch (error) {
    logger.error(
      `An unexpected error occurred during the background prompt synchronization process: ${String(error)}`,
    );
  }
}
