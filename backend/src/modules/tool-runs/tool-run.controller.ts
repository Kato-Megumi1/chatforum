import { Body, Controller, Get, Header, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Equals, IsBoolean, Matches } from 'class-validator';
import { ApiResponse } from '../../common/response.class';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { TOOL_POLICY_VERSION } from './tool-run.policy';
import { ToolRunService } from './tool-run.service';

class ToolDecisionDto {
  @IsBoolean() approved: boolean;
  @Matches(/^[a-f\d]{64}$/) argsHash: string;
  @Equals(TOOL_POLICY_VERSION) policyVersion: string;
}
@Controller('chat/tool-runs')
@UseGuards(JwtAuthGuard)
export class ToolRunController {
  constructor(private readonly tools:ToolRunService){}
  @Get('approvals') @Header('Cache-Control','private, no-store') async approvals(@CurrentUser() user:{sub:number;authVersion?:number},
    @Query('conversationId',ParseIntPipe) conversationId:unknown){
    return ApiResponse.ok(await this.tools.approvals(user.sub,conversationId as number,user.authVersion??0));
  }
  @Get(':runId/steps') @Header('Cache-Control','private, no-store') async steps(@CurrentUser() user:{sub:number;authVersion?:number},@Param('runId',ParseUUIDPipe) runId:string){
    return ApiResponse.ok(await this.tools.steps(user.sub,runId,user.authVersion??0));
  }
  @Post(':runId/steps/:stepId/decision') @Header('Cache-Control','private, no-store') async decide(@CurrentUser() user:{sub:number;authVersion?:number},
    @Param('runId',ParseUUIDPipe) runId:string,@Param('stepId',ParseUUIDPipe) stepId:string,@Body() input:ToolDecisionDto){
    return ApiResponse.ok(await this.tools.decide(user.sub,runId,stepId,input.approved,input.argsHash,input.policyVersion,user.authVersion??0));
  }
}
