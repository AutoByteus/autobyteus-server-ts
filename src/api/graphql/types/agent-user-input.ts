import { Field, InputType, registerEnumType } from "type-graphql";
import { ContextFileType } from "autobyteus-ts";

registerEnumType(ContextFileType, {
  name: "ContextFileType",
});

@InputType()
export class ContextFilePathInput {
  @Field(() => String)
  path!: string;

  @Field(() => ContextFileType)
  type!: ContextFileType;
}

@InputType()
export class AgentUserInput {
  @Field(() => String)
  content!: string;

  @Field(() => [ContextFilePathInput], { nullable: true })
  contextFiles?: ContextFilePathInput[] | null;
}
