import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import { CodingService } from '../../coding/coding.service';
import { LocalWorkspaceService } from '../../coding/local-workspace.service';
import { ArtifactReviewService, ArtifactReviewSummary } from '../../coding/artifact-review.service';
import { BaseSkill, SkillExecutionContext, SkillTool } from './skill.interface';

export class CodingSkill extends BaseSkill {
  constructor(private readonly coding: CodingService, private readonly local?: LocalWorkspaceService,
    private readonly reviews?: ArtifactReviewService) { super(); }
  tool: SkillTool = {
    name: 'code_workspace',
    description: '当前会话附件：list目录；read文本、PDF指定页、Word或图片（图片/扫描页需Qwen）；search文字层；propose保存可下载新版本，原件不变。HTML在隔离服务启用且选Qwen时自动截图视觉验收及最多一次修复复检。check仅代码语法。无终端/本机目录能力。',
    parameters: { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['list', 'read', 'search', 'propose', 'check'] },
      path: { type: 'string', maxLength: 180, description: '代码相对路径，如src/main.ts；不接受绝对路径、..、隐藏文件或环境文件' },
      startLine: { type: 'integer', minimum: 1, description: 'read起始行，默认1，每次最多120行；后续按nextLine读取' },
      page: { type: 'integer', minimum: 1, maximum: 100, description: 'read PDF页码，默认1；按nextPage继续；Word正文不分页' },
      query: { type: 'string', minLength: 1, maxLength: 100, description: 'search字面关键词；或read图片/扫描页时的视觉问题' },
      expectedRevision: { type: 'integer', minimum: 0, description: 'propose必填：read所得版本；创建文件为0' },
      oldText: { type: 'string', minLength: 1, maxLength: 64000, description: '更新时替换的唯一原片段，不包含read显示的行号' },
      newText: { type: 'string', maxLength: 64000, description: '替换片段，可为空；与oldText一起使用' },
      content: { type: 'string', maxLength: 64000, description: '新建或整文件替换的完整内容；不能与oldText/newText混用' },
      description: { type: 'string', minLength: 1, maxLength: 240, description: 'propose必填，修改内容和目的' },
    } },
  };
  async execute(args: Record<string, unknown>, context: SkillExecutionContext) {
    context.signal?.throwIfAborted();
    try {
      if (context.codingWorkspaceId) throw new HttpException('本机目录模式已停用，请通过＋上传文件副本', 409);
      let result: any = await this.coding.tool(args, context);
      // A proposal transaction may finish concurrently with cancellation. Do not start
      // rendering/review or publish its artifact after the task has been stopped.
      context.signal?.throwIfAborted();
      if ('proposalId' in result && typeof result.proposalId === 'number' && 'path' in result && typeof result.path === 'string' && context.fileArtifacts &&
          !context.fileArtifacts.some(a => a.changeId === result.proposalId)) context.fileArtifacts.push({ changeId: result.proposalId, path: result.path });
      if (args.action === 'propose' && 'proposalId' in result && typeof result.proposalId === 'number' && 'path' in result &&
          typeof result.path === 'string' && /\.html$/i.test(result.path)) {
        let review: ArtifactReviewSummary;
        const attempts = context.artifactReviewAttempts ||= new Map<string, number>();
        const key = result.path.toLowerCase(), count = attempts.get(key) || 0;
        if (count >= 2) review = { status: 'not_reviewed', issues: ['此路径已进行初验和一次修复复检；本新版本未继续自动视觉验收。'] };
        else if (!this.reviews) review = { status: 'unavailable', issues: ['隔离视觉验收未启用，本文件仅已生成可下载副本。'] };
        else {
          attempts.set(key, count + 1);
          try {
            const change = await this.coding.change(result.proposalId, context);
            if(count===0){
              const checked=await this.reviews.reviewAndRepair(change,context,context.fileQuestionContext?.question||'',context.signal);
              review=checked.visualReview;
              attempts.set(key,checked.repairAttempted?2:1);
              result={...result,...checked.proposalResult,repairAttempted:checked.repairAttempted,
                ...('previousChangeId' in checked?{previousChangeId:checked.previousChangeId}:{}),
                ...('repairError' in checked?{repairError:checked.repairError}:{})};
              for(const record of checked.records)(context.artifactReviews ||= []).push(record);
            }else review = await this.reviews.review(change, context, context.fileQuestionContext?.question || '', context.signal);
          } catch { context.signal?.throwIfAborted(); review = { status: 'unavailable', issues: ['视觉验收未完成，生成文件仍可下载。'] }; }
        }
        if(!context.artifactReviews?.some(row=>row.changeId===result.proposalId&&row.review===review))
          (context.artifactReviews ||= []).push({ changeId: result.proposalId, path: result.path, review });
        if(context.fileArtifacts){
          const others=context.fileArtifacts.filter(item=>item.path.toLowerCase()!==key);
          context.fileArtifacts.splice(0,context.fileArtifacts.length,...others,{changeId:result.proposalId,path:result.path,review});
        }
        result = { ...result, visualReview: review, instruction:'生成文件已保存，原附件和本机文件未变。' +
          (review.status==='passed'?'此版本完成隔离截图与视觉检查，不等于完整业务测试通过。':
            review.status==='issues'?'视觉检查仍有问题，请如实说明；文件仍可下载。':'此版本未完成视觉验收，不可声称已通过。') + '未部署页面，不提供宿主机终端执行能力。' };
      }
      return { success: true, result, displayText: JSON.stringify(result), modelData: { trust: 'untrusted_code', ...result } };
    } catch (error) {
      context.signal?.throwIfAborted();
      const message = error instanceof ZodError ? '参数不符合定义，请检查action和必要字段' : error instanceof HttpException ? error.message : '代码工作区暂时不可用，请重试';
      return { success: false, result: { error: message }, displayText: message, modelData: { error: message } };
    }
  }
}
