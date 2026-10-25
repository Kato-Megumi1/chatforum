import { IsEmail, IsString, MinLength, MaxLength, IsOptional, IsByteLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ description: '用户邮箱' })
  @IsEmail()
  @MaxLength(191)
  email: string;

  @ApiProperty({ description: '用户名' })
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  username: string;

  @ApiProperty({ description: '密码：至少6个字符，UTF-8编码不超过72字节' })
  @IsString()
  @MinLength(6, { message: '密码至少6个字符' })
  @IsByteLength(0, 72, { message: '密码不能超过72字节（中文及表情会占多个字节）' })
  password: string;

  @ApiProperty({ description: '11位中国大陆手机号（可选）', required: false })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() || undefined : value)
  @IsOptional()
  @IsString()
  @Matches(/^1[3-9]\d{9}$/, { message: '请输入11位中国大陆手机号' })
  phone?: string;
}
