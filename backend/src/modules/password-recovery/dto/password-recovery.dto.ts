import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, Matches, MinLength, IsByteLength, ValidateBy } from 'class-validator';

export class RecoveryCodeDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail() @MaxLength(191)
  email: string;
}

export class ResetRecoveredPasswordDto extends RecoveryCodeDto {
  @IsString() @Matches(/^\d{6}$/, { message: '请输入6位邮箱验证码' })
  code: string;

  @IsString() @MinLength(6, { message: '新密码至少6个字符' })
  @IsByteLength(0, 72, { message: '新密码不能超过72字节（中文及表情会占多个字节）' })
  @Matches(/\S/u, { message: '新密码不能全部为空格' })
  newPassword: string;

  @IsString() @IsByteLength(0, 72)
  @ValidateBy({ name: 'matchesRecoveryPassword', validator: {
    validate: (value, args) => value === (args.object as ResetRecoveredPasswordDto).newPassword,
    defaultMessage: () => '两次输入的新密码不一致',
  } })
  confirmPassword: string;
}
