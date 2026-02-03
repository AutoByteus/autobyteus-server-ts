import { Arg, Field, Mutation, ObjectType, Query, Resolver } from "type-graphql";
import { GraphQLJSON } from "graphql-scalars";
import { appConfigProvider } from "../../../config/app-config-provider.js";
import { llmModelService } from "../../../llm-management/services/llm-model-service.js";
import type { ModelInfo } from "autobyteus-ts/llm/models.js";
import { LLMProvider } from "autobyteus-ts/llm/providers.js";
import { audioModelService } from "../../../multimedia-management/services/audio-model-service.js";
import { imageModelService } from "../../../multimedia-management/services/image-model-service.js";
import type { AudioModel } from "autobyteus-ts/multimedia/audio/audio-model.js";
import type { ImageModel } from "autobyteus-ts/multimedia/image/image-model.js";

@ObjectType()
class ModelDetail {
  @Field(() => String)
  modelIdentifier!: string;

  @Field(() => String)
  name!: string;

  @Field(() => String)
  value!: string;

  @Field(() => String)
  canonicalName!: string;

  @Field(() => String)
  provider!: string;

  @Field(() => String)
  runtime!: string;

  @Field(() => String, { nullable: true })
  hostUrl?: string | null;

  @Field(() => GraphQLJSON, { nullable: true })
  configSchema?: Record<string, unknown> | null;
}

@ObjectType()
class ProviderWithModels {
  @Field(() => String)
  provider!: string;

  @Field(() => [ModelDetail])
  models!: ModelDetail[];
}

const mapLlmModel = (model: ModelInfo): ModelDetail => ({
  modelIdentifier: model.model_identifier,
  name: model.display_name,
  value: model.value,
  canonicalName: model.canonical_name,
  provider: model.provider,
  runtime: model.runtime,
  hostUrl: model.host_url ?? null,
  configSchema: model.config_schema ?? null,
});

const mapAudioModel = (model: AudioModel): ModelDetail => ({
  modelIdentifier: model.modelIdentifier,
  name: model.name,
  value: model.value,
  canonicalName: model.name,
  provider: String(model.provider),
  runtime: String(model.runtime),
  hostUrl: model.hostUrl ?? null,
  configSchema: model.parameterSchema?.toJsonSchemaDict?.() ?? null,
});

const mapImageModel = (model: ImageModel): ModelDetail => ({
  modelIdentifier: model.modelIdentifier,
  name: model.name,
  value: model.value,
  canonicalName: model.name,
  provider: String(model.provider),
  runtime: String(model.runtime),
  hostUrl: model.hostUrl ?? null,
  configSchema: model.parameterSchema?.toJsonSchemaDict?.() ?? null,
});

const groupModelsByProvider = (models: ModelDetail[]): Map<string, ModelDetail[]> => {
  const grouped = new Map<string, ModelDetail[]>();
  for (const model of models) {
    const list = grouped.get(model.provider) ?? [];
    list.push(model);
    grouped.set(model.provider, list);
  }
  return grouped;
};

const sortModels = (models: ModelDetail[]): ModelDetail[] =>
  models.slice().sort((a, b) => a.name.localeCompare(b.name));

@Resolver()
export class LlmProviderResolver {
  @Query(() => String, { nullable: true })
  getLlmProviderApiKey(@Arg("provider", () => String) provider: string): string | null {
    try {
      const apiKey = appConfigProvider.config.getLlmApiKey(provider);
      return apiKey ?? null;
    } catch (error) {
      console.error(`Error retrieving API key: ${String(error)}`);
      return null;
    }
  }

  @Query(() => [ProviderWithModels])
  async availableLlmProvidersWithModels(): Promise<ProviderWithModels[]> {
    const modelsInfo = await llmModelService.getAvailableModels();
    const modelDetails = modelsInfo.map(mapLlmModel);
    const grouped = groupModelsByProvider(modelDetails);

    const providers: ProviderWithModels[] = Object.values(LLMProvider).map((provider) => ({
      provider,
      models: sortModels(grouped.get(provider) ?? []),
    }));

    return providers.sort((a, b) => a.provider.localeCompare(b.provider));
  }

  @Query(() => [ProviderWithModels])
  async availableAudioProvidersWithModels(): Promise<ProviderWithModels[]> {
    const models = (await audioModelService.getAvailableModels()).map(mapAudioModel);
    const grouped = groupModelsByProvider(models);

    const providers = Array.from(grouped.entries()).map(([provider, items]) => ({
      provider,
      models: sortModels(items),
    }));

    return providers.sort((a, b) => a.provider.localeCompare(b.provider));
  }

  @Query(() => [ProviderWithModels])
  async availableImageProvidersWithModels(): Promise<ProviderWithModels[]> {
    const models = (await imageModelService.getAvailableModels()).map(mapImageModel);
    const grouped = groupModelsByProvider(models);

    const providers = Array.from(grouped.entries()).map(([provider, items]) => ({
      provider,
      models: sortModels(items),
    }));

    return providers.sort((a, b) => a.provider.localeCompare(b.provider));
  }

  @Mutation(() => String)
  setLlmProviderApiKey(
    @Arg("provider", () => String) provider: string,
    @Arg("apiKey", () => String) apiKey: string,
  ): string {
    try {
      if (!provider || !apiKey) {
        throw new Error("Both provider and api_key must be provided.");
      }
      appConfigProvider.config.setLlmApiKey(provider, apiKey);
      return `API key for provider ${provider} has been set successfully.`;
    } catch (error) {
      return `Error setting API key: ${String(error)}`;
    }
  }

  @Mutation(() => String)
  async reloadLlmModels(): Promise<string> {
    try {
      await llmModelService.reloadModels();
      await audioModelService.reloadModels();
      await imageModelService.reloadModels();
      return "All models (LLM and Multimedia) reloaded successfully.";
    } catch (error) {
      return `Error reloading models: ${String(error)}`;
    }
  }

  @Mutation(() => String)
  async reloadLlmProviderModels(@Arg("provider", () => String) provider: string): Promise<string> {
    if (!provider) {
      return "Error reloading provider models: provider must be specified.";
    }

    try {
      const normalized = provider.trim().toUpperCase();
      const providerEnum = (LLMProvider as Record<string, LLMProvider>)[normalized];
      if (!providerEnum) {
        return `Error reloading models for provider ${provider}: Unsupported provider.`;
      }

      const count = await llmModelService.reloadModelsForProvider(providerEnum);
      return `Reloaded ${count} models for provider ${providerEnum} successfully.`;
    } catch (error) {
      return `Error reloading models for provider ${provider}: ${String(error)}`;
    }
  }
}
