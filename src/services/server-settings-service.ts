import { appConfigProvider } from "../config/app-config-provider.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export class ServerSettingDescription {
  constructor(
    public readonly key: string,
    public readonly description: string,
  ) {}
}

export class ServerSettingsService {
  private settingsInfo = new Map<string, ServerSettingDescription>();

  constructor() {
    this.initializeSettings();
  }

  private initializeSettings(): void {
    this.settingsInfo.set(
      "AUTOBYTEUS_LLM_SERVER_HOSTS",
      new ServerSettingDescription(
        "AUTOBYTEUS_LLM_SERVER_HOSTS",
        "Comma-separated URLs of AUTOBYTEUS LLM servers",
      ),
    );

    this.settingsInfo.set(
      "AUTOBYTEUS_LLM_SERVER_URL",
      new ServerSettingDescription(
        "AUTOBYTEUS_LLM_SERVER_URL",
        "URL of the AUTOBYTEUS LLM server",
      ),
    );

    this.settingsInfo.set(
      "AUTOBYTEUS_SERVER_HOST",
      new ServerSettingDescription(
        "AUTOBYTEUS_SERVER_HOST",
        "Public URL of this server (e.g., http://localhost:8000). This is mandatory and set at startup.",
      ),
    );

    this.settingsInfo.set(
      "AUTOBYTEUS_VNC_SERVER_URL",
      new ServerSettingDescription(
        "AUTOBYTEUS_VNC_SERVER_URL",
        "URL of the AUTOBYTEUS VNC server (e.g., localhost:5900)",
      ),
    );

    this.settingsInfo.set(
      "DEFAULT_OLLAMA_HOST",
      new ServerSettingDescription(
        "DEFAULT_OLLAMA_HOST",
        "Host URL for the Ollama server (e.g., http://localhost:11434)",
      ),
    );

    this.settingsInfo.set(
      "LMSTUDIO_HOST",
      new ServerSettingDescription(
        "LMSTUDIO_HOST",
        "Host URL for the LM Studio server (e.g., http://localhost:1234)",
      ),
    );

    this.settingsInfo.set(
      "AUTOBYTEUS_PROMPT_SYNC_ON_STARTUP",
      new ServerSettingDescription(
        "AUTOBYTEUS_PROMPT_SYNC_ON_STARTUP",
        "Enable automatic prompt synchronization from the marketplace on server startup. Set to 'true' to enable. Default is 'false' (disabled).",
      ),
    );

    logger.info(
      `Initialized server settings service with ${this.settingsInfo.size} predefined settings`,
    );
  }

  getAvailableSettings(): Array<{ key: string; value: string; description: string }> {
    const config = appConfigProvider.config;
    const allSettings = config.getConfigData();

    const result: Array<{ key: string; value: string; description: string }> = [];

    for (const [key, value] of Object.entries(allSettings)) {
      if (key.toUpperCase().endsWith("_API_KEY")) {
        continue;
      }

      const description = this.settingsInfo.get(key)?.description ?? "Custom user-defined setting";
      result.push({
        key,
        value: String(value),
        description,
      });
    }

    result.sort((a, b) => a.key.localeCompare(b.key));
    return result;
  }

  updateSetting(key: string, value: string): [boolean, string] {
    try {
      const config = appConfigProvider.config;
      config.set(key, value);

      if (!this.settingsInfo.has(key)) {
        this.settingsInfo.set(
          key,
          new ServerSettingDescription(key, "Custom user-defined setting"),
        );
        logger.info(`Added new custom server setting: ${key}`);
      }

      logger.info(`Server setting '${key}' updated to '${value}'`);
      return [true, `Server setting '${key}' has been updated successfully.`];
    } catch (error) {
      logger.error(`Error updating server setting '${key}': ${String(error)}`);
      return [false, `Error updating server setting: ${String(error)}`];
    }
  }

  isValidSetting(_key: string): boolean {
    return true;
  }
}

let cachedServerSettingsService: ServerSettingsService | null = null;

export const getServerSettingsService = (): ServerSettingsService => {
  if (!cachedServerSettingsService) {
    cachedServerSettingsService = new ServerSettingsService();
  }
  return cachedServerSettingsService;
};
