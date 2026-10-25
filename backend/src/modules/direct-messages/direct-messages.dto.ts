import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class DirectInboxQuery {
  @IsOptional() @IsIn(['inbox', 'requests']) box: 'inbox' | 'requests' = 'inbox';
  @IsOptional() @IsString() @MaxLength(2048) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) limit = 20;
}
export class DirectMessagesQuery {
  @IsOptional() @IsString() @MaxLength(2048) cursor?: string;
  @IsOptional() @IsString() @Matches(/^[1-9]\d{0,18}$/) afterId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 30;
}
export class DirectCreateDto {
  @Type(() => Number) @IsInt() @Min(1) recipientId: number;
}
export class DirectSendDto {
  @IsString() @MaxLength(2000) content: string;
  @IsUUID('4') clientMessageId: string;
}
export class DirectReadDto {
  @IsString() @Matches(/^[1-9]\d{0,18}$/) lastReadMessageId: string;
}
export class DirectRequestDto {
  @IsIn(['accept', 'decline', 'block']) action: 'accept' | 'decline' | 'block';
}
export class DirectBlockDto {
  @IsBoolean() blocked: boolean;
}
export class DirectContactsQuery {
  @IsString() @MaxLength(40) query: string;
}
