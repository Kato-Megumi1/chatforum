import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Optional, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { AttachmentService } from './attachment.service';
import { ATTACHMENT_LIMITS } from './attachment.policy';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { ApiResponse } from '../../common/response.class';
import { CodingService } from './coding.service';
import { CODING_LIMITS, importFiles } from './coding.policy';
import { ArtifactReviewService } from './artifact-review.service';

@Controller('coding/:conversationId')
@UseGuards(JwtAuthGuard)
export class CodingController {
  constructor(private readonly coding: CodingService, private readonly attachments: AttachmentService,
    @Optional() private readonly reviews?: ArtifactReviewService) {}
  @Get('changes/:id/review/:reviewId') async review(@CurrentUser() user:{sub:number}, @Param('conversationId',ParseIntPipe) conversationId:number,
    @Param('id',ParseIntPipe) id:number, @Param('reviewId',ParseUUIDPipe) reviewId:string, @Res({passthrough:true}) res:Response) {
    if(!this.reviews)throw new NotFoundException('验收报告不可用');
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
    return ApiResponse.ok(await this.reviews.getReport(id,reviewId,{userId:user.sub,conversationId}));
  }
  @Get('changes/:id/review/:reviewId/images/:index') async reviewImage(@CurrentUser() user:{sub:number}, @Param('conversationId',ParseIntPipe) conversationId:number,
    @Param('id',ParseIntPipe) id:number, @Param('reviewId',ParseUUIDPipe) reviewId:string, @Param('index',ParseIntPipe) index:number, @Res() res:Response) {
    if(!this.reviews)throw new NotFoundException('验收报告不可用');
    const data=await this.reviews.getImage(id,reviewId,index,{userId:user.sub,conversationId});
    res.setHeader('Content-Type','image/png');res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.send(data);
  }
  @Get('files/:id/download') async textOriginal(@CurrentUser() user:{sub:number}, @Param('conversationId',ParseIntPipe) conversationId:number,
    @Param('id',ParseIntPipe) id:number, @Query('revision',ParseIntPipe) revision:number, @Res() res:Response) {
    this.sendFile(res,await this.coding.originalText(id,revision,{userId:user.sub,conversationId}));
  }
  @Delete('files/:id') async remove(@CurrentUser() user: {sub:number}, @Param('conversationId',ParseIntPipe) conversationId:number,
    @Param('id',ParseIntPipe) id:number, @Query() query:unknown) {
    const parsed = z.object({kind:z.enum(['text','attachment']),revision:z.coerce.number().int().positive().max(2147483647)}).strict().safeParse(query);
    if (!parsed.success || id < 1) throw new BadRequestException('文件编号、类型或版本无效');
    return ApiResponse.ok(await this.coding.remove(id, parsed.data.kind, parsed.data.revision, {userId:user.sub,conversationId}));
  }
  @Post('attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: ATTACHMENT_LIMITS.fileBytes, files: 1, fields: 0, parts: 2 } }))
  async attach(@CurrentUser() user: {sub:number}, @Param('conversationId', ParseIntPipe) conversationId: number, @UploadedFile() file: {originalname:string;buffer:Buffer}) {
    if (!file) throw new BadRequestException('请选择文件');
    // Browsers encode multipart filenames as UTF-8; Multer exposes the header as latin1.
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return ApiResponse.created(await this.attachments.upload(name, file.buffer, { userId:user.sub, conversationId }));
  }
  private sendFile(res: Response, file: {name:string;mime:string;data:Buffer}) {
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g,'%27')}`);
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store');
    res.send(file.data);
  }
  @Get('attachments/:id/download') async original(@CurrentUser() user:{sub:number}, @Param('conversationId',ParseIntPipe) conversationId:number, @Param('id',ParseIntPipe) id:number, @Res() res:Response) {
    this.sendFile(res, await this.attachments.original(id,{userId:user.sub,conversationId}));
  }
  @Get('changes/:id/download') async download(@CurrentUser() user:{sub:number}, @Param('conversationId',ParseIntPipe) conversationId:number, @Param('id',ParseIntPipe) id:number, @Res() res:Response) {
    this.sendFile(res, await this.attachments.downloadChange(id,{userId:user.sub,conversationId}));
  }
  @Get() async overview(@CurrentUser() user: { sub: number }, @Param('conversationId', ParseIntPipe) conversationId: number) {
    return ApiResponse.ok(await this.coding.overview({ userId: user.sub, conversationId }));
  }
  @Post('files') async upload(@CurrentUser() user: { sub: number }, @Param('conversationId', ParseIntPipe) conversationId: number, @Body() input: unknown) {
    // Zod 3 validates every element before applying array.max(). Reject the
    // transport cardinality first so invalid batches cannot amplify issues.
    const files=input&&typeof input==='object'?(input as Record<string,unknown>).files:undefined;
    if(!Array.isArray(files)||files.length<1||files.length>CODING_LIMITS.files)
      throw new BadRequestException('需要1～60个代码文本文件，每个文件最多64KB');
    const parsed = importFiles.safeParse(input);
    if (!parsed.success) throw new BadRequestException('需要1～60个代码文本文件，每个文件最多64KB');
    return ApiResponse.created(await this.coding.upload(parsed.data, { userId: user.sub, conversationId }));
  }
  @Get('files') async files(@CurrentUser() user: { sub: number }, @Param('conversationId', ParseIntPipe) conversationId: number) {
    return ApiResponse.ok(await this.coding.export({ userId: user.sub, conversationId }));
  }
  @Get('changes/:id') async change(@CurrentUser() user: { sub: number }, @Param('conversationId', ParseIntPipe) conversationId: number, @Param('id', ParseIntPipe) id: number) {
    return ApiResponse.ok(await this.coding.change(id, { userId: user.sub, conversationId }));
  }
  @Post('changes/:id/decision') async decide(@CurrentUser() user: { sub: number }, @Param('conversationId', ParseIntPipe) conversationId: number,
    @Param('id', ParseIntPipe) id: number, @Body() body: { decision?: unknown }) {
    if (!body || !['apply', 'reject'].includes(body.decision as string) || Object.keys(body).length !== 1) throw new BadRequestException('请选择应用或拒绝');
    return ApiResponse.ok(await this.coding.decide(id, body.decision as 'apply' | 'reject', { userId: user.sub, conversationId }));
  }
}
