import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { ApiResponse } from '../../common/response.class';
import { PositiveIntIdPipe } from '../../common/positive-int-id.pipe';
import { CreateForumAppealDto, CreateForumReportDto } from './forum-reports.dto';
import { ForumReportsService } from './forum-reports.service';

@Controller('forum/reports')
@UseGuards(JwtAuthGuard)
export class ForumReportsController {
  constructor(private readonly reports:ForumReportsService){}
  @Post() async create(@CurrentUser() user:{sub:number;authVersion?:number},@Body() data:CreateForumReportDto){
    return ApiResponse.created(await this.reports.create(user.sub,user.authVersion??0,data));
  }
  @Get() @Header('Cache-Control','private, no-store')
  async mine(@CurrentUser() user:{sub:number;authVersion?:number},@Query() query:any){return ApiResponse.ok(await this.reports.mine(user.sub,user.authVersion??0,query));}
  @Get('decisions') @Header('Cache-Control','private, no-store')
  async decisions(@CurrentUser() user:{sub:number;authVersion?:number},@Query() query:any){return ApiResponse.ok(await this.reports.decisions(user.sub,user.authVersion??0,query));}
  @Post(':id/appeal') async appeal(@CurrentUser() user:{sub:number;authVersion?:number},@Param('id',PositiveIntIdPipe) id:string,@Body() data:CreateForumAppealDto){
    return ApiResponse.created(await this.reports.appeal(user.sub,user.authVersion??0,Number(id),data));
  }
}
