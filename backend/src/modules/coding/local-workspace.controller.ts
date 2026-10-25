import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, ParseIntPipe, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { ApiResponse } from '../../common/response.class';
import { LocalWorkspaceService } from './local-workspace.service';
@Controller('coding/:conversationId/local')
@UseGuards(JwtAuthGuard)
export class LocalWorkspaceController {
  constructor(private readonly local: LocalWorkspaceService) {}
  private token(s: string) { if (!/^[a-f0-9]{64}$/.test(s || '')) throw new BadRequestException('缺少浏览器工作区凭据'); return s; }
  @Post() async connect(@CurrentUser() u: { sub: number }, @Param('conversationId', ParseIntPipe) conversationId: number, @Body() body: unknown) {
    const input = z.object({ name: z.string().min(1).max(120).regex(/^[^\\/\x00-\x1f]+$/) }).strict().safeParse(body);
    if (!input.success) throw new BadRequestException('仅提交文件夹名称，不提交本机绝对路径');
    return ApiResponse.ok(await this.local.connect({ userId: u.sub, conversationId }, input.data.name));
  }
  @Get(':id') async poll(@CurrentUser() u: { sub: number }, @Param('conversationId', ParseIntPipe) conversationId: number, @Param('id', ParseUUIDPipe) id: string, @Headers('x-workspace-token') token: string) {
    return ApiResponse.ok(await this.local.poll({ userId: u.sub, conversationId }, id, this.token(token)));
  }
  @Post(':id/operations/:operationId/authorize') async authorize(@CurrentUser() u: { sub: number }, @Param('conversationId', ParseIntPipe) conversationId: number, @Param('id', ParseUUIDPipe) id: string, @Param('operationId', ParseUUIDPipe) operationId: string, @Headers('x-workspace-token') token: string) {
    return ApiResponse.ok(await this.local.authorize({ userId: u.sub, conversationId }, id, this.token(token), operationId));
  }
  @Post(':id/operations/:operationId') async complete(@CurrentUser() u: { sub: number }, @Param('conversationId', ParseIntPipe) conversationId: number, @Param('id', ParseUUIDPipe) id: string, @Param('operationId', ParseUUIDPipe) operationId: string, @Headers('x-workspace-token') token: string, @Body() body: unknown) {
    const input = z.object({ success: z.boolean(), data: z.record(z.unknown()).optional(), error: z.string().max(300).optional() }).strict().safeParse(body);
    if (!input.success) throw new BadRequestException('操作回执格式错误');
    return ApiResponse.ok(await this.local.complete({ userId: u.sub, conversationId }, id, this.token(token), operationId, input.data));
  }
  @Delete(':id') async disconnect(@CurrentUser() u: { sub: number }, @Param('conversationId', ParseIntPipe) conversationId: number, @Param('id', ParseUUIDPipe) id: string, @Headers('x-workspace-token') token: string) {
    return ApiResponse.ok(await this.local.disconnect({ userId: u.sub, conversationId }, id, this.token(token)));
  }
}
