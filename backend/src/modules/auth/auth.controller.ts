import { Controller, Post, Body, HttpCode, HttpStatus, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ApiResponse as ApiResponseClass } from '../../common/response.class';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: '用户注册' })
  @ApiResponse({ status: 201, description: '注册成功' })
  async register(@Body() registerDto: RegisterDto, @Req() req: Request) {
    const result = await this.authService.register(registerDto, { ip: req.ip, userAgent: req.get('user-agent') });
    return ApiResponseClass.created(result, 'Registration successful');
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '用户登录' })
  @ApiResponse({ status: 200, description: '登录成功' })
  async login(@Body() loginDto: LoginDto, @Req() req: Request) {
    const result = await this.authService.login(loginDto, { ip: req.ip, userAgent: req.get('user-agent') });
    return ApiResponseClass.ok(result, 'Login successful');
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '刷新 Token' })
  async refresh(@Body('refreshToken') refreshToken: string) {
    const result = await this.authService.refreshTokens(refreshToken);
    return ApiResponseClass.ok(result, 'Token refreshed');
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '用户登出' })
  async logout(@Body('refreshToken') refreshToken: string) {
    const result = await this.authService.logout(refreshToken);
    return ApiResponseClass.ok(result, 'Logout successful');
  }

  @Post('password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '校验当前密码后修改本人密码，并撤销旧登录会话' })
  async changePassword(@CurrentUser() user: {sub:number}, @Body() data: ChangePasswordDto, @Req() req: Request) {
    return ApiResponseClass.ok(await this.authService.changePassword(user.sub, data, { ip: req.ip, userAgent: req.get('user-agent') }));
  }
}
