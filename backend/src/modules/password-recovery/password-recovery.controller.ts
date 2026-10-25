import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ApiResponse } from '../../common/response.class';
import { PasswordRecoveryService } from './password-recovery.service';
import { RecoveryCodeDto, ResetRecoveredPasswordDto } from './dto/password-recovery.dto';

@ApiTags('密码找回')
@Controller('auth/password-recovery')
export class PasswordRecoveryController {
  constructor(private readonly recovery: PasswordRecoveryService) {}
  @Post('code') @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '向注册邮箱发送密码找回验证码（统一响应，不披露账号是否存在）' })
  async code(@Body() data: RecoveryCodeDto, @Req() req: Request) {
    return ApiResponse.ok(await this.recovery.requestCode(data.email, { ip: req.ip, userAgent: req.get('user-agent') }));
  }
  @Post('reset') @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '验证单次邮箱验证码后重置密码，并撤销旧会话' })
  async reset(@Body() data: ResetRecoveredPasswordDto, @Req() req: Request) {
    return ApiResponse.ok(await this.recovery.resetPassword(data, { ip: req.ip, userAgent: req.get('user-agent') }));
  }
}
