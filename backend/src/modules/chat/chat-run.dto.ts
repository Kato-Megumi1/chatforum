import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CHAT_MODEL_IDS } from './chat-models';

class MessageAttachmentDto {
  @IsInt() @Min(1) id:number;
  @IsIn(['text','attachment']) kind:'text'|'attachment';
  @IsInt() @Min(1) revision:number;
}
class ResumeFileDto {
  @IsUUID() draftId: string;
  @IsInt() @Min(1) revision: number;
  @IsString() @Matches(/^[a-f\d]{64}$/) hash: string;
}
// History, filenames and provider credentials are deliberately not accepted from the browser.
export class ChatRunDto {
  @IsUUID() requestId: string;
  @IsOptional() @IsUUID() codingWorkspaceId?: string;
  @IsInt() @Min(1) conversationId: number;
  @IsString() @MaxLength(12000) question: string;
  @IsOptional() @ValidateNested() @Type(()=>ResumeFileDto) resumeFile?: ResumeFileDto;
  @IsOptional() @IsArray() @ArrayMaxSize(80) @ValidateNested({each:true}) @Type(()=>MessageAttachmentDto) attachments?:MessageAttachmentDto[];
  @IsIn(['normal', 'agent']) mode: 'normal' | 'agent';
  @IsOptional() @IsIn(CHAT_MODEL_IDS) modelId?: string;
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() deepThinking?: boolean;
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() webSearch?: boolean;
  @IsOptional() @IsString() @MaxLength(100) persona?: string;
  @IsOptional() @IsString() @MaxLength(6000) customSystemPrompt?: string;
  @IsOptional() @IsInt() @Min(1) knowledgeBaseId?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) enabledSkills?: string[];
}
