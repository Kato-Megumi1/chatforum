import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import { NotificationType } from '@prisma/client';

export class PostDto {
  @Transform(({value}) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(150) title: string;
  @Transform(({value}) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(50000) content: string;
  @IsOptional() @IsIn(['plain', 'markdown']) contentFormat?: 'plain' | 'markdown';
  @IsInt() @Min(1) categoryId: number;
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(10)
  @IsString({ each: true }) @MinLength(1, { each: true }) @MaxLength(30, { each: true }) tags?: string[];
}
export class UpdatePostDto extends PartialType(PostDto) {
  @IsInt() @Min(1) expectedRevision: number;
}
export class CommentDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(4000) content: string;
  @IsOptional() @IsInt() @Min(1) parentId?: number;
}
export class CommentQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) limit = 10;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) parentId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) commentId?: number;
  @IsOptional() @IsIn(['asc', 'desc']) sortOrder: 'asc' | 'desc' = 'desc';
  @IsOptional() @Transform(({value}) => value === true || value === 'true' ? true : value === false || value === 'false' ? false : value)
  @IsBoolean() onlyAuthor = false;
}
export class FeedQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) categoryId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) tagId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) userId?: number;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsIn(['latest', 'hot']) sort: 'latest' | 'hot' = 'latest';
  @IsOptional() @IsIn(['today', 'week', 'all']) hotPeriod: 'today' | 'week' | 'all' = 'week';
  @IsOptional() @IsIn(['asc', 'desc']) sortOrder: 'asc' | 'desc' = 'desc';
  @IsOptional() @IsIn(['published', 'interaction']) hotBasis: 'published' | 'interaction' = 'published';
  @IsOptional() @IsString() @MaxLength(16000) cursor?: string;
  @IsOptional() @Transform(({value}) => value === true || value === 'true' ? true : value === false || value === 'false' ? false : value)
  @IsBoolean() includeTotal = false;
}
export class TagsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 30;
}
export class TagOptionsQueryDto {
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) limit = 20;
  @IsOptional() @IsString() @MaxLength(4096) cursor?: string;
}
export class PostQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) categoryId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) tagId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) userId?: number;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsIn(['createdAt', 'popular', 'likes']) sortBy = 'createdAt';
  @IsOptional() @IsIn(['latest', 'hot', 'likes']) sort?: 'latest' | 'hot' | 'likes';
  @IsOptional() @IsIn(['today', 'week', 'all']) hotPeriod: 'today' | 'week' | 'all' = 'week';
  @IsOptional() @IsIn(['asc', 'desc']) sortOrder: 'asc' | 'desc' = 'desc';
  @IsOptional() @Transform(({value}) => value === true || value === 'true' ? true : value === false || value === 'false' ? false : value)
  @IsBoolean() includeTotal = true;
}
export class PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
}
export class NotificationQueryDto extends PageQueryDto {
  @IsOptional() @Transform(({value}) => value === true || value === 'true' ? true : value === false || value === 'false' ? false : value)
  @IsBoolean() unreadOnly = false;
  @IsOptional() @IsEnum(NotificationType)
  type?: NotificationType;
}
export class ViewDto {
  @IsOptional() @IsString() @MaxLength(160) viewerToken?: string;
}
export class ForumSubscriptionDto {
  @IsIn(['NEW_POSTS','POST_ACTIVITY','HOT_RISE']) kind: 'NEW_POSTS' | 'POST_ACTIVITY' | 'HOT_RISE';
  @IsOptional() @IsInt() @Min(1) categoryId?: number;
  @IsOptional() @IsInt() @Min(1) postId?: number;
  @IsOptional() @IsString() @MaxLength(160) query?: string;
  @IsOptional() @IsIn([24,168]) hours?: 24 | 168;
  @IsOptional() @IsIn(['published','interaction']) rankingBasis?: 'published' | 'interaction';
  @IsOptional() @IsInt() @Min(60) @Max(86400) cooldownSeconds?: number;
}
export class ForumSubscriptionToggleDto { @IsBoolean() enabled: boolean; }
