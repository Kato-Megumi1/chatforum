import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional() @IsString() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @MinLength(1) @MaxLength(30)
  username?: string;

  @IsOptional() @IsString() @MaxLength(500)
  bio?: string;

  @IsOptional() @IsString() @MaxLength(160) @Matches(/^\/uploads\/avatars\/[\w.-]+$/)
  avatar?: string;
}

export class SocialListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2147483647)
  cursor?: number;
}
