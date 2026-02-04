import { Arg, Field, Mutation, ObjectType, Query, Resolver } from "type-graphql";
import { getServerSettingsService } from "../../../services/server-settings-service.js";

@ObjectType()
export class ServerSetting {
  @Field(() => String)
  key!: string;

  @Field(() => String)
  value!: string;

  @Field(() => String)
  description!: string;
}

@Resolver()
export class ServerSettingsResolver {
  private get serverSettingsService() {
    return getServerSettingsService();
  }

  @Query(() => [ServerSetting])
  getServerSettings(): ServerSetting[] {
    const settings = this.serverSettingsService.getAvailableSettings();
    return settings.map((setting) => ({
      key: setting.key,
      value: setting.value,
      description: setting.description,
    }));
  }

  @Mutation(() => String)
  updateServerSetting(
    @Arg("key", () => String) key: string,
    @Arg("value", () => String) value: string,
  ): string {
    const [, message] = this.serverSettingsService.updateSetting(key, value);
    return message;
  }
}
