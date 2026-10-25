import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, UseInterceptors,
  UploadedFile, ParseIntPipe, ParseUUIDPipe } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ApiResponse } from '../../common/response.class';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { RagService } from '../agent/rag.service';
import { RagIndexService } from '../agent/rag-index.service';
import { AclDto, CanaryDto, DocumentAccessDto, KnowledgeBaseDto, ResolveReviewDto, SearchDto } from './rag.dto';

const upload = FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

@ApiTags('小说原文与角色记忆')
@Controller('rag')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class RagController {
  constructor(private readonly rag: RagService, private readonly indexes: RagIndexService) {}

  @Post('knowledge-bases')
  async create(@Body() data: KnowledgeBaseDto, @CurrentUser() u: { sub: number }) {
    return ApiResponse.created(await this.rag.createKnowledgeBase(data, { userId: u.sub }));
  }
  @Get('knowledge-bases')
  async list(@CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.listKnowledgeBases({ userId: u.sub }));
  }
  @Get('knowledge-bases/:id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.getKnowledgeBase(id, { userId: u.sub }));
  }
  @Put('knowledge-bases/:id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() data: KnowledgeBaseDto, @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.updateKnowledgeBase(id, data, { userId: u.sub }));
  }
  @Delete('knowledge-bases/:id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: { sub: number }) {
    await this.rag.deleteKnowledgeBase(id, { userId: u.sub });
    return ApiResponse.ok(null);
  }
  @Put('knowledge-bases/:id/acl/:userId')
  async acl(@Param('id', ParseIntPipe) id: number, @Param('userId', ParseIntPipe) userId: number,
    @Body() data: AclDto, @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.setAcl(id, userId, data.permission, { userId: u.sub }));
  }
  @Delete('knowledge-bases/:id/acl/:userId')
  async revoke(@Param('id', ParseIntPipe) id: number, @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.setAcl(id, userId, null, { userId: u.sub }));
  }
  @Post('knowledge-bases/:id/documents')
  @UseInterceptors(upload)
  async upload(@Param('id', ParseIntPipe) id: number, @UploadedFile() file: any, @CurrentUser() u: { sub: number }) {
    return ApiResponse.created(await this.rag.addDocument(id, file, { userId: u.sub }));
  }
  @Post('knowledge-bases/:id/documents/:docId/versions')
  @UseInterceptors(upload)
  async version(@Param('id', ParseIntPipe) id: number, @Param('docId', ParseIntPipe) docId: number,
    @UploadedFile() file: any, @CurrentUser() u: { sub: number }) {
    return ApiResponse.created(await this.rag.addDocument(id, file, { userId: u.sub }, docId));
  }
  @Delete('knowledge-bases/:id/documents/:docId')
  async deleteDocument(@Param('id', ParseIntPipe) id: number, @Param('docId', ParseIntPipe) docId: number,
    @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.deleteDocument(id, docId, { userId: u.sub }));
  }
  @Put('knowledge-bases/:id/documents/:docId/access')
  async docAccess(@Param('id', ParseIntPipe) id: number, @Param('docId', ParseIntPipe) docId: number,
    @Body() data: DocumentAccessDto, @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.documentAccess(id, docId, data.visibility, { userId: u.sub }));
  }
  @Put('knowledge-bases/:id/documents/:docId/acl/:userId')
  async docAcl(@Param('id', ParseIntPipe) id: number, @Param('docId', ParseIntPipe) docId: number,
    @Param('userId', ParseIntPipe) userId: number, @Body() data: AclDto, @CurrentUser() u: { sub: number }) {
    await this.rag.documentAcl(id, docId, userId, data.permission, { userId: u.sub });
    return ApiResponse.ok(null);
  }
  @Delete('knowledge-bases/:id/documents/:docId/acl/:userId')
  async revokeDocAcl(@Param('id', ParseIntPipe) id: number, @Param('docId', ParseIntPipe) docId: number,
    @Param('userId', ParseIntPipe) userId: number, @CurrentUser() u: { sub: number }) {
    await this.rag.documentAcl(id, docId, userId, null, { userId: u.sub });
    return ApiResponse.ok(null);
  }
  @Post('knowledge-bases/:id/reindex')
  async reindex(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: { sub: number }) {
    return ApiResponse.created(await this.indexes.enqueue(id, { userId: u.sub }));
  }
  @Get('knowledge-bases/:id/indexes')
  async indexesList(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.indexes.list(id, { userId: u.sub }));
  }
  @Put('knowledge-bases/:id/canary')
  async canary(@Param('id', ParseIntPipe) id: number, @Body() data: CanaryDto, @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.indexes.publish(id, data.version, { userId: u.sub }, data.percent));
  }
  @Post('knowledge-bases/:id/indexes/:version/activate')
  async activate(@Param('id', ParseIntPipe) id: number, @Param('version', ParseIntPipe) version: number,
    @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.indexes.publish(id, version, { userId: u.sub }));
  }
  @Post('knowledge-bases/:id/search')
  async search(@Param('id', ParseIntPipe) id: number, @Body() data: SearchDto, @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.search(id, data.query, { userId: u.sub }, data.topK));
  }
  @Get('knowledge-bases/:id/citations/:chunkId')
  async citation(@Param('id', ParseIntPipe) id: number, @Param('chunkId', ParseUUIDPipe) chunkId: string,
    @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.citation(id, chunkId, { userId: u.sub }));
  }
  @Get('knowledge-bases/:id/reviews')
  async reviews(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.reviews(id, { userId: u.sub }));
  }
  @Post('knowledge-bases/:id/indexes/:version/graph')
  async buildGraph(@Param('id', ParseIntPipe) id: number, @Param('version', ParseIntPipe) version: number, @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.buildGraph(id, version, { userId: u.sub }));
  }
  @Get('knowledge-bases/:id/graph')
  async graph(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.graphView(id, { userId: u.sub }));
  }
  @Put('knowledge-bases/:id/reviews/:taskId')
  async resolve(@Param('id', ParseIntPipe) id: number, @Param('taskId', ParseIntPipe) taskId: number,
    @Body() data: ResolveReviewDto, @CurrentUser() u: { sub: number }) {
    return ApiResponse.ok(await this.rag.resolveReview(id, taskId, data.answer, data.status, { userId: u.sub }));
  }
}
