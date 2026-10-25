import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConversationIdentityDto {
  @IsOptional() @IsIn(['ASSISTANT', 'ROLEPLAY']) conversationType?: string;
  @IsOptional() @IsIn(['kato_megumi_persona', 'yukinoshita_yukino_persona', 'custom']) persona?: string;
  @IsOptional() @IsString() @MaxLength(80) personaLabel?: string;
  @IsOptional() @IsString() @MaxLength(6000) customPersonaPrompt?: string;
}
export class CreateConversationDto extends ConversationIdentityDto {
  @IsOptional() @IsString() @MaxLength(100) title?: string;
}
export class UpdateConversationDto {
  @IsOptional() @IsString() @MaxLength(100) title?: string;
  @IsOptional() @IsBoolean() isPinned?: boolean;
  @IsOptional() @IsBoolean() sharedMemory?: boolean;
}
