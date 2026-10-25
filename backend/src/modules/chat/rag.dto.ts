import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class KnowledgeBaseDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsIn(['PRIVATE', 'SHARED', 'PUBLIC']) visibility?: 'PRIVATE' | 'SHARED' | 'PUBLIC';
  @IsOptional() @Type(() => Number) @IsInt() @Min(100) @Max(2000) chunkSize?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(500) chunkOverlap?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.3) @Max(1) minConfidence?: number;
}

export class AclDto {
  @IsIn(['READ', 'WRITE', 'ADMIN']) permission: 'READ' | 'WRITE' | 'ADMIN';
}

export class DocumentAccessDto {
  @IsIn(['INHERIT', 'PRIVATE', 'PUBLIC']) visibility: 'INHERIT' | 'PRIVATE' | 'PUBLIC';
}

export class CanaryDto {
  @Type(() => Number) @IsInt() @Min(1) version: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(100) percent: number;
}

export class SearchDto {
  @IsString() @MinLength(1) @MaxLength(2000) query: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) topK?: number;
}

export class ResolveReviewDto {
  @IsIn(['RESOLVED', 'REJECTED']) status: 'RESOLVED' | 'REJECTED';
  @IsString() @MinLength(1) @MaxLength(8000) answer: string;
}
