import { IsEmail, IsString, MinLength, MaxLength, IsByteLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ description: '用户邮箱' })
  @IsEmail()
  @MaxLength(191)
  email: string;

  @ApiProperty({ description: '密码' })
  @IsString()
  @MinLength(6)
  @IsByteLength(6, 72)
  password: string;
}
