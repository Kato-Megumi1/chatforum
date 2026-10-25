import { Controller, Get, Put, Body, Param, Query, ParseIntPipe, UseGuards, Post, Delete, UseInterceptors, UploadedFile, Logger } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserService } from './user.service';
import { ApiResponse, ApiError } from '../../common/response.class';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { OptionalJwtAuthGuard } from '../../guards/optional-jwt-auth.guard';
import * as path from 'path';
import { SocialListQueryDto, UpdateProfileDto } from './user.dto';

@ApiTags('用户')
@Controller('users')
export class UserController {
  private readonly logger = new Logger(UserController.name);

  constructor(private readonly userService: UserService) {}

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取当前用户信息' })
  async getProfile(@CurrentUser() user: { sub: number }) {
    const result = await this.userService.findOne(user.sub);
    return ApiResponse.ok(result);
  }

  @Put('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新用户信息' })
  async updateProfile(@CurrentUser() user: { sub: number }, @Body() data: UpdateProfileDto) {
    const result = await this.userService.updateProfile(user.sub, data);
    return ApiResponse.ok(result, 'Profile updated');
  }

  @Post('avatar')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '上传头像' })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async uploadAvatar(@CurrentUser() user: { sub: number }, @UploadedFile() file: any) {
    if (!file) return ApiError.badRequest('File is required');

    const b: Buffer = file.buffer;
    const ext = b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? '.png' :
      b.subarray(0, 3).equals(Buffer.from([255,216,255])) ? '.jpg' :
      /^GIF8[79]a$/.test(b.subarray(0, 6).toString()) ? '.gif' :
      b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' ? '.webp' : null;
    if (!ext) {
      return ApiError.badRequest('Only jpg/png/gif/webp allowed');
    }

    const avatarDir = path.join(process.cwd(), 'uploads', 'avatars');
    await fs.mkdir(avatarDir, { recursive: true });

    const fileName = `${user.sub}_${randomUUID()}${ext}`;
    const filePath = path.join(avatarDir, fileName);
    await fs.writeFile(filePath, file.buffer, { flag: 'wx' });

    const avatarUrl = `/uploads/avatars/${fileName}`;
    await this.userService.updateProfile(user.sub, { avatar: avatarUrl });

    return ApiResponse.ok({ url: avatarUrl }, 'Avatar uploaded');
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: '获取指定用户信息' })
  async getUserProfile(@Param('id', ParseIntPipe) id: number, @CurrentUser() user?: { sub: number }) {
    const result = await this.userService.getUserProfile(id, user?.sub);
    return ApiResponse.ok(result);
  }

  @Post(':id/follow')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '关注用户' })
  async followUser(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: { sub: number }) {
    const result = await this.userService.followUser(user.sub, id);
    return ApiResponse.ok(result);
  }

  @Delete(':id/follow')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '取消关注用户' })
  async unfollowUser(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: { sub: number }) {
    const result = await this.userService.unfollowUser(user.sub, id);
    return ApiResponse.ok(result);
  }

  @Get(':id/followers')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: '获取用户粉丝列表' })
  async getUserFollowers(@Param('id', ParseIntPipe) id: number, @Query() params: SocialListQueryDto, @CurrentUser() user?: { sub: number }) {
    const result = await this.userService.getUserFollowers(id, params, user?.sub);
    return ApiResponse.ok(result);
  }

  @Get(':id/following')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: '获取用户关注列表' })
  async getUserFollowing(@Param('id', ParseIntPipe) id: number, @Query() params: SocialListQueryDto, @CurrentUser() user?: { sub: number }) {
    const result = await this.userService.getUserFollowing(id, params, user?.sub);
    return ApiResponse.ok(result);
  }
}
