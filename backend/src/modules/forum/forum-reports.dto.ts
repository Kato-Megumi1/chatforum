import { IsIn, IsInt, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateForumReportDto {
  @IsUUID() requestId: string;
  @IsIn(['POST','COMMENT']) type: 'POST'|'COMMENT';
  @IsInt() @Min(1) targetId: number;
  @IsIn(['垃圾广告','人身攻击','隐私泄露','违法违规','其他']) reason: string;
  @IsString() @MaxLength(1800) detail: string;
}
export class CreateForumAppealDto {
  @IsInt() @Min(1) expectedRevision: number;
  @IsString() @MaxLength(2000) reason: string;
}
