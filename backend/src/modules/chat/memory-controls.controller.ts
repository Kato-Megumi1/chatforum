import { BadRequestException, Body, Controller, Get, Header, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsString, Matches, Min } from 'class-validator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { ApiResponse } from '../../common/response.class';
import { MemoryControlsService } from '../agent/memory-controls.service';

class MemoryActionDto {
  @IsIn(['episode','pin']) kind:'episode'|'pin';
  @IsInt() @Min(1) id:number;
  @IsString() @Matches(/^[a-f\d]{64}$/) version:string;
}
const pageBefore=(value:unknown):number|undefined=>{
  if(value===undefined)return;
  if(typeof value!=='string'||!/^\d{1,10}$/.test(value)||Number(value)<1)throw new BadRequestException('无效的分页');
  return Number(value);
};
@Controller('chat/memory')
@UseGuards(JwtAuthGuard)
export class MemoryControlsController {
  constructor(private readonly memory:MemoryControlsService) {}
  @Get('conversations') @Header('Cache-Control','private, no-store')
  async conversations(@CurrentUser() user:{sub:number},@Query('before') before?:unknown) {
    return ApiResponse.ok(await this.memory.conversations(user.sub,pageBefore(before)));
  }
  @Get(':id') @Header('Cache-Control','private, no-store')
  async entries(@CurrentUser() user:{sub:number},@Param('id',ParseIntPipe) id:unknown,@Query('before') before?:unknown) {
    return ApiResponse.ok(await this.memory.entries(user.sub,id as number,pageBefore(before)));
  }
  @Post(':id/sources') @Header('Cache-Control','private, no-store')
  async sources(@CurrentUser() user:{sub:number},@Param('id',ParseIntPipe) id:unknown,@Body() body:MemoryActionDto) {
    return ApiResponse.ok(await this.memory.sources(user.sub,id as number,body));
  }
  @Post(':id/pin') async pin(@CurrentUser() user:{sub:number},@Param('id',ParseIntPipe) id:unknown,@Body() body:MemoryActionDto) {
    return ApiResponse.ok(await this.memory.pin(user.sub,id as number,body));
  }
  @Post(':id/unpin') async unpin(@CurrentUser() user:{sub:number},@Param('id',ParseIntPipe) id:unknown,@Body() body:MemoryActionDto) {
    return ApiResponse.ok(await this.memory.unpin(user.sub,id as number,body));
  }
  @Post(':id/forget') async forget(@CurrentUser() user:{sub:number},@Param('id',ParseIntPipe) id:unknown,@Body() body:MemoryActionDto) {
    return ApiResponse.ok(await this.memory.forget(user.sub,id as number,body));
  }
}
