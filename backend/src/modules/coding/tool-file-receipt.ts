import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SkillExecutionContext } from '../agent/skills/skill.interface';
import { CodingService } from './coding.service';

// Agent tool envelopes and the narrow direct-file channel share the same
// immutable proposal check. No raw source or stored tool result reaches the UI.
export async function restoreToolFileReceipt(coding: CodingService | undefined, text: string, context: SkillExecutionContext) {
  const envelope = JSON.parse(text);
  if (envelope?.success === false) return;
  const data = envelope?.data || envelope?.result;
  if (!coding || !Number.isSafeInteger(data?.proposalId) || typeof data.path !== 'string')
    throw new ServiceUnavailableException('文件提案回执无效');
  const change = await coding.restoreToolProposal(data.proposalId, data.path, context);
  const review = data.visualReview;
  if (review?.sourceHash && review.sourceHash !== createHash('sha256').update(change.after,'utf8').digest('hex'))
    throw new ServiceUnavailableException('文件验收版本已变化');
  if (!context.fileArtifacts?.some(row => row.changeId === change.id))
    context.fileArtifacts?.push({changeId:change.id,path:change.path,...(review?{review}:{})});
}
