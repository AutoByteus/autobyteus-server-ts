import { AudioClientFactory } from "autobyteus-ts/multimedia/audio/audio-client-factory.js";
import { AutobyteusAudioModelProvider } from "autobyteus-ts/multimedia/audio/autobyteus-audio-provider.js";
import type { AudioModel } from "autobyteus-ts/multimedia/audio/audio-model.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export class AudioModelProvider {
  async listModels(): Promise<AudioModel[]> {
    logger.info("Fetching list of available Audio models from AudioClientFactory...");
    try {
      logger.info("Awaiting Autobyteus audio model discovery before listing models...");
      await AutobyteusAudioModelProvider.ensureDiscovered();
      const models = AudioClientFactory.listModels();
      logger.info(`Successfully fetched ${models.length} audio models from AudioClientFactory.`);
      return models;
    } catch (error) {
      logger.error(`Failed to list Audio models from AudioClientFactory: ${String(error)}`);
      return [];
    }
  }

  async refreshModels(): Promise<void> {
    logger.info("Triggering AudioClientFactory re-initialization to refresh models...");
    try {
      AudioClientFactory.reinitialize();
      logger.info("AudioClientFactory re-initialized successfully.");
    } catch (error) {
      logger.error(`Failed to re-initialize AudioClientFactory: ${String(error)}`);
      throw error;
    }
  }
}
