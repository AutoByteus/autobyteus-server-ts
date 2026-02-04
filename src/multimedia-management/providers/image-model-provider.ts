import { ImageClientFactory } from "autobyteus-ts/multimedia/image/image-client-factory.js";
import { AutobyteusImageModelProvider } from "autobyteus-ts/multimedia/image/autobyteus-image-provider.js";
import type { ImageModel } from "autobyteus-ts/multimedia/image/image-model.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export class ImageModelProvider {
  async listModels(): Promise<ImageModel[]> {
    logger.info("Fetching list of available Image models from ImageClientFactory...");
    try {
      logger.info("Awaiting Autobyteus image model discovery before listing models...");
      await AutobyteusImageModelProvider.ensureDiscovered();
      const models = ImageClientFactory.listModels();
      logger.info(`Successfully fetched ${models.length} image models from ImageClientFactory.`);
      return models;
    } catch (error) {
      logger.error(`Failed to list Image models from ImageClientFactory: ${String(error)}`);
      return [];
    }
  }

  async refreshModels(): Promise<void> {
    logger.info("Triggering ImageClientFactory re-initialization to refresh models...");
    try {
      ImageClientFactory.reinitialize();
      logger.info("ImageClientFactory re-initialized successfully.");
    } catch (error) {
      logger.error(`Failed to re-initialize ImageClientFactory: ${String(error)}`);
      throw error;
    }
  }
}
