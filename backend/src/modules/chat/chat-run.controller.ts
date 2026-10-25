import { BadRequestException, Body, Controller, Delete, Get, Header, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { once } from 'node:events';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { ApiResponse } from '../../common/response.class';
import { ChatRunDto } from './chat-run.dto';
import { ChatRunService } from './chat-run.service';
import { runEvents } from './chat-run.events';

@Controller('chat/runs')
@UseGuards(JwtAuthGuard)
export class ChatRunController {
  constructor(private readonly runs: ChatRunService) {}
  @Post() async create(@CurrentUser() user: { sub: number }, @Body() input: ChatRunDto) {
    return ApiResponse.created(await this.runs.create(user.sub, input));
  }
  @Get('recovery') @Header('Cache-Control', 'private, no-store')
  async recovery(@CurrentUser() user: { sub: number; authVersion?: number },
    // Keep the raw query uncoerced until ParseIntPipe validates its decimal syntax.
    @Query('conversationId', ParseIntPipe) conversationId: unknown) {
    return ApiResponse.ok(await this.runs.recovery(user.sub, conversationId as number, user.authVersion ?? 0));
  }
  @Get(':id') async get(@CurrentUser() user: { sub: number; authVersion?: number }, @Param('id', ParseUUIDPipe) id: string) {
    return ApiResponse.ok(await this.runs.get(user.sub, id, user.authVersion ?? 0));
  }
  @Get(':id/events') async events(@CurrentUser() user: { sub: number; authVersion?: number }, @Param('id', ParseUUIDPipe) id: string,
    @Query('offset') cursor: string | undefined, @Res() res: Response) {
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^\d{1,7}$/.test(cursor)))
      throw new BadRequestException('无效的流式偏移量');
    const offset = Number(cursor || 0);
    const initial = await this.runs.get(user.sub, id, user.authVersion ?? 0); // HTTP 401/403/404 before sending SSE headers.
    if (offset > ((initial.result as any)?.content || '').length)
      throw new BadRequestException('无效的流式偏移量');
    const controller = new AbortController();
    const close = () => controller.abort();
    res.on('close', close);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    try {
      for await (const frame of runEvents(() => this.runs.get(user.sub, id, user.authVersion ?? 0), offset, controller.signal)) {
        const wire = (frame.id === undefined ? '' : `id: ${frame.id}\n`) +
          `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
        if (!res.write(wire)) await once(res, 'drain', { signal: controller.signal });
      }
    } catch {
      if (!controller.signal.aborted) res.write('event: terminal\ndata: ' + JSON.stringify({
        status: 'FAILED', error: '输出中断或权限已改变，请重新打开对话检查'
      }) + '\n\n');
    } finally {
      res.off('close', close);
      if (!res.writableEnded) res.end();
    }
  }
  @Delete(':id') async cancel(@CurrentUser() user: { sub: number }, @Param('id', ParseUUIDPipe) id: string) {
    return ApiResponse.ok(await this.runs.cancel(user.sub, id));
  }
}
