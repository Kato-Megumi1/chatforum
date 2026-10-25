import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { ApiResponse } from '../../common/response.class';
import { DirectMessagesService } from './direct-messages.service';
import {
  DirectBlockDto,
  DirectContactsQuery,
  DirectCreateDto,
  DirectInboxQuery,
  DirectMessagesQuery,
  DirectReadDto,
  DirectRequestDto,
  DirectSendDto,
} from './direct-messages.dto';
type User = { sub: number; authVersion?: number };
const actor = (user: User) => ({ id: user.sub, authVersion: user.authVersion ?? 0 });

@Controller('direct-messages')
@UseGuards(JwtAuthGuard)
@UseInterceptors({
  intercept(context, next) {
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    return next.handle();
  },
})
export class DirectMessagesController {
  constructor(private readonly dm: DirectMessagesService) {}
  @Get('contacts') async contacts(@CurrentUser() u: User, @Query() q: DirectContactsQuery) {
    return ApiResponse.ok(await this.dm.contacts(actor(u), q.query));
  }
  @Get('unread-count') async unread(@CurrentUser() u: User) {
    return ApiResponse.ok(await this.dm.unread(actor(u)));
  }
  @Get('conversations') async list(@CurrentUser() u: User, @Query() q: DirectInboxQuery) {
    return ApiResponse.ok(await this.dm.list(actor(u), q));
  }
  @Post('conversations') async create(@CurrentUser() u: User, @Body() b: DirectCreateDto) {
    return ApiResponse.created(await this.dm.create(actor(u), b.recipientId));
  }
  @Get('conversations/:id') async get(
    @CurrentUser() u: User,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return ApiResponse.ok(await this.dm.get(actor(u), id));
  }
  @Get('conversations/:id/messages') async messages(
    @CurrentUser() u: User,
    @Param('id', ParseIntPipe) id: number,
    @Query() q: DirectMessagesQuery,
  ) {
    return ApiResponse.ok(await this.dm.messages(actor(u), id, q));
  }
  @Post('conversations/:id/messages') async send(
    @CurrentUser() u: User,
    @Param('id', ParseIntPipe) id: number,
    @Body() b: DirectSendDto,
  ) {
    return ApiResponse.created(await this.dm.send(actor(u), id, b));
  }
  @Put('conversations/:id/read') async read(
    @CurrentUser() u: User,
    @Param('id', ParseIntPipe) id: number,
    @Body() b: DirectReadDto,
  ) {
    return ApiResponse.ok(await this.dm.read(actor(u), id, b.lastReadMessageId));
  }
  @Patch('conversations/:id/request') async request(
    @CurrentUser() u: User,
    @Param('id', ParseIntPipe) id: number,
    @Body() b: DirectRequestDto,
  ) {
    return ApiResponse.ok(await this.dm.request(actor(u), id, b.action));
  }
  @Put('users/:id/block') async block(
    @CurrentUser() u: User,
    @Param('id', ParseIntPipe) id: number,
    @Body() b: DirectBlockDto,
  ) {
    return ApiResponse.ok(await this.dm.block(actor(u), id, b.blocked));
  }
}
