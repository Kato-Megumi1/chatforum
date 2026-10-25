import { IsString, MinLength, IsByteLength, Matches, ValidateBy } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ description: '当前密码' })
  @IsString() @MinLength(1) @IsByteLength(1, 72)
  oldPassword: string;

  @ApiProperty({ description: '新密码：至少6个字符，UTF-8编码不超过72字节' })
  @IsString() @MinLength(6, { message: '新密码至少6个字符' })
  @IsByteLength(0, 72, { message: '新密码不能超过72字节（中文及表情会占多个字节）' })
  @Matches(/\S/u, { message: '新密码不能全部为空格' })
  newPassword: string;

  @ApiProperty({ description: '再次输入新密码' })
  @IsString() @IsByteLength(0, 72)
  @ValidateBy({ name: 'matchesNewPassword', validator: {
    validate: (value, args) => value === (args.object as ChangePasswordDto).newPassword,
    defaultMessage: () => '两次输入的新密码不一致',
  } })
  confirmPassword: string;
}
