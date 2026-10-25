import { Controller, Get, Post, Put, Patch, Delete, Body, Param, UseGuards, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PostDto, UpdatePostDto, CommentDto, PostQueryDto, CommentQueryDto, PageQueryDto, NotificationQueryDto, ViewDto,
  FeedQueryDto, TagsQueryDto, TagOptionsQueryDto, ForumSubscriptionDto, ForumSubscriptionToggleDto } from './forum.dto';
import { ForumSubscriptionsService } from './forum-subscriptions.service';
import { ForumService } from './forum.service';
import { ApiResponse } from '../../common/response.class';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../../guards/optional-jwt-auth.guard';
import { PositiveIntIdPipe } from '../../common/positive-int-id.pipe';

@ApiTags('论坛')
@Controller('forum')
export class ForumController {
  constructor(private readonly forumService: ForumService, private readonly subscriptions: ForumSubscriptionsService) {}

  @Get('subscriptions') @UseGuards(JwtAuthGuard)
  async watches(@CurrentUser() user: {sub:number}) { return ApiResponse.ok(await this.subscriptions.list(user.sub)); }
  @Post('subscriptions') @UseGuards(JwtAuthGuard)
  async watch(@CurrentUser() user: {sub:number}, @Body() data: ForumSubscriptionDto) { return ApiResponse.created(await this.subscriptions.create(user.sub, data)); }
  @Patch('subscriptions/:id') @UseGuards(JwtAuthGuard)
  async toggleWatch(@CurrentUser() user: {sub:number}, @Param('id', PositiveIntIdPipe) id: string, @Body() data: ForumSubscriptionToggleDto) {
    return ApiResponse.ok(await this.subscriptions.setEnabled(user.sub, Number(id), data.enabled));
  }
  @Delete('subscriptions/:id') @UseGuards(JwtAuthGuard)
  async removeWatch(@CurrentUser() user: {sub:number}, @Param('id', PositiveIntIdPipe) id: string) { return ApiResponse.ok(await this.subscriptions.remove(user.sub, Number(id))); }

  @Get('posts')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: '获取帖子列表' })
  async getPosts(
    @Query() params: PostQueryDto,
    @CurrentUser() user?: { sub: number },
  ) {
    const result = await this.forumService.getPosts(params, user?.sub);
    return ApiResponse.ok(result);
  }

  @Get('feed')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: '获取绑定筛选与时间边界的帖子游标页（默认不统计总数）' })
  async getFeed(@Query() params: FeedQueryDto, @CurrentUser() user?: { sub: number }) {
    return ApiResponse.ok(await this.forumService.getFeed(params, user?.sub));
  }

  @Post('posts')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建帖子' })
  async createPost(
    @CurrentUser() user: { sub: number },
    @Body() data: PostDto,
  ) {
    const result = await this.forumService.createPost(user.sub, data);
    return ApiResponse.created(result);
  }

  @Get('posts/:id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: '获取帖子详情' })
  async getPost(
    @Param('id', PositiveIntIdPipe) id: string,
    @CurrentUser() user?: { sub: number },
  ) {
    const result = await this.forumService.getPost(Number(id), user?.sub);
    return ApiResponse.ok(result);
  }

  @Post('posts/:id/view')
  @UseGuards(OptionalJwtAuthGuard)
  async recordView(@Param('id', PositiveIntIdPipe) id: string, @Body() data: ViewDto,
    @CurrentUser() user: { sub: number } | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const match = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('forum-viewer='));
    const cookieToken = match?.slice('forum-viewer='.length);
    const result = await this.forumService.recordView(Number(id), user?.sub, data.viewerToken || cookieToken);
    if (result.viewerToken) res.cookie('forum-viewer', result.viewerToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', maxAge: 30 * 86400000, path: '/api/forum' });
    return ApiResponse.ok(result);
  }

  @Put('posts/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新帖子' })
  async updatePost(
    @Param('id', PositiveIntIdPipe) id: string,
    @CurrentUser() user: { sub: number },
    @Body() data: UpdatePostDto,
  ) {
    const result = await this.forumService.updatePost(Number(id), user.sub, data);
    return ApiResponse.ok(result);
  }

  @Delete('posts/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '删除帖子' })
  async deletePost(
    @Param('id', PositiveIntIdPipe) id: string,
    @CurrentUser() user: { sub: number },
  ) {
    const result = await this.forumService.deletePost(Number(id), user.sub);
    return ApiResponse.ok(result);
  }

  @Post('posts/:id/like')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '点赞帖子' })
  async likePost(
    @Param('id', PositiveIntIdPipe) id: string,
    @CurrentUser() user: { sub: number },
  ) {
    const result = await this.forumService.likePost(Number(id), user.sub);
    return ApiResponse.ok(result);
  }

  @Delete('posts/:id/like')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '取消点赞帖子' })
  async unlikePost(
    @Param('id', PositiveIntIdPipe) id: string,
    @CurrentUser() user: { sub: number },
  ) {
    const result = await this.forumService.unlikePost(Number(id), user.sub);
    return ApiResponse.ok(result);
  }

  @Post('posts/:id/favorite')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '收藏帖子' })
  async favoritePost(
    @Param('id', PositiveIntIdPipe) id: string,
    @CurrentUser() user: { sub: number },
  ) {
    const result = await this.forumService.favoritePost(Number(id), user.sub);
    return ApiResponse.ok(result);
  }

  @Delete('posts/:id/favorite')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '取消收藏帖子' })
  async unfavoritePost(
    @Param('id', PositiveIntIdPipe) id: string,
    @CurrentUser() user: { sub: number },
  ) {
    const result = await this.forumService.unfavoritePost(Number(id), user.sub);
    return ApiResponse.ok(result);
  }

  @Get('posts/:id/comments')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: '获取帖子评论' })
  async getComments(
    @Param('id', PositiveIntIdPipe) id: string,
    @Query() query: CommentQueryDto,
    @CurrentUser() user?: { sub: number },
  ) {
    const result = await this.forumService.getComments(Number(id), user?.sub, query);
    return ApiResponse.ok(result);
  }

  @Post('posts/:id/comments')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建评论' })
  async createComment(
    @Param('id', PositiveIntIdPipe) id: string,
    @CurrentUser() user: { sub: number },
    @Body() data: CommentDto,
  ) {
    const result = await this.forumService.createComment(Number(id), user.sub, data);
    return ApiResponse.created(result);
  }

  @Post('comments/:id/like')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '点赞评论' })
  async likeComment(
    @Param('id', PositiveIntIdPipe) id: string,
    @CurrentUser() user: { sub: number },
  ) {
    const result = await this.forumService.likeComment(Number(id), user.sub);
    return ApiResponse.ok(result);
  }

  @Delete('comments/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async deleteComment(@Param('id', PositiveIntIdPipe) id: string, @CurrentUser() user: { sub: number }) {
    return ApiResponse.ok(await this.forumService.deleteComment(Number(id), user.sub));
  }

  @Delete('comments/:id/like')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '取消点赞评论' })
  async unlikeComment(
    @Param('id', PositiveIntIdPipe) id: string,
    @CurrentUser() user: { sub: number },
  ) {
    const result = await this.forumService.unlikeComment(Number(id), user.sub);
    return ApiResponse.ok(result);
  }

  @Get('categories')
  @ApiOperation({ summary: '获取分类列表' })
  async getCategories() {
    const result = await this.forumService.getCategories();
    return ApiResponse.ok(result);
  }

  @Get('tags')
  @ApiOperation({ summary: '获取标签列表' })
  async getTags(@Query() params: TagsQueryDto) {
    const result = await this.forumService.getTags(params.limit);
    return ApiResponse.ok(result);
  }

  @Get('tag-options')
  @ApiOperation({ summary: '搜索公开帖子标签选项，按名称游标分页' })
  async getTagOptions(@Query() params: TagOptionsQueryDto) {
    return ApiResponse.ok(await this.forumService.getTagOptions(params));
  }

  @Get('notifications')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取通知' })
  async getNotifications(@CurrentUser() user: { sub: number }, @Query() query: NotificationQueryDto) {
    const result = await this.forumService.getNotifications(user.sub, query);
    return ApiResponse.ok(result);
  }

  @Get('notifications/unread-count')
  @UseGuards(JwtAuthGuard)
  async unreadNotifications(@CurrentUser() user: {sub:number}) {
    return ApiResponse.ok(await this.forumService.unreadNotificationCount(user.sub));
  }

  @Put('notifications/read-all')
  @UseGuards(JwtAuthGuard)
  async readAllNotifications(@CurrentUser() user: {sub:number}) {
    return ApiResponse.ok(await this.forumService.markAllNotificationsRead(user.sub));
  }

  @Get('me/posts')
  @UseGuards(JwtAuthGuard)
  async myPosts(@CurrentUser() user: {sub:number}, @Query() query: PageQueryDto) {
    return ApiResponse.ok(await this.forumService.personalPosts(user.sub, 'posts', query));
  }
  @Get('me/favorites')
  @UseGuards(JwtAuthGuard)
  async myFavorites(@CurrentUser() user: {sub:number}, @Query() query: PageQueryDto) {
    return ApiResponse.ok(await this.forumService.personalPosts(user.sub, 'favorites', query));
  }
  @Get('me/replies')
  @UseGuards(JwtAuthGuard)
  async myReplies(@CurrentUser() user: {sub:number}, @Query() query: PageQueryDto) {
    return ApiResponse.ok(await this.forumService.personalReplies(user.sub, query));
  }
  @Get('me/following')
  @UseGuards(JwtAuthGuard)
  async myFollowing(@CurrentUser() user: {sub:number}, @Query() query: PageQueryDto) {
    return ApiResponse.ok(await this.forumService.personalFollowing(user.sub, query));
  }

  @Put('notifications/:id/read')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '标记通知已读' })
  async markNotificationRead(
    @Param('id', PositiveIntIdPipe) id: string,
    @CurrentUser() user: { sub: number },
  ) {
    const result = await this.forumService.markNotificationRead(Number(id), user.sub);
    return ApiResponse.ok(result);
  }
}
