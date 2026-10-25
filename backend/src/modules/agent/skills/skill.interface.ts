export interface AgentSkill {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  isTool?: boolean;  // false for persona/config skills that only inject system prompts
}

export interface SkillTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface SkillResult {
  success: boolean;
  result: any;
  displayText: string;
  modelData?: unknown;
}

import { PrismaService } from '../../../common/prisma.service';

export interface SkillExecutionContext {
  apiKey?: string;
  userId?: number;
  conversationId?: number;
  codingWorkspaceId?: string;
  runId?: string;
  workerToken?: string; // Server worker lease only; never a model argument.
  fileSourceEpoch?: number;
  signal?: AbortSignal;
  webSearch?: boolean;
  webSources?: Array<{title:string;url:string;snippet:string;engine:string;retrievedAt:string}>;
  webSearchFailures?: string[];
  forumMemo?: Map<string, Promise<SkillResult>>;
  forumPostIds?: Set<number>;
  fileArtifacts?: Array<{ changeId: number; path: string; review?: {status:string;reviewId?:string;sourceHash?:string;issues?:string[]} }>;
  artifactReviews?: Array<{changeId:number;path:string;review:{status:string;reviewId?:string;sourceHash?:string;issues?:string[]}}>; artifactReviewAttempts?: Map<string,number>;
  fileQuestionContext?: { question: string; history: Array<{ role: string; content: string }> };
  prismaService?: PrismaService;
}

export abstract class BaseSkill {
  abstract tool: SkillTool;
  abstract execute(args: Record<string, any>, context: SkillExecutionContext): Promise<SkillResult>;

  getOpenAIFunction(): any {
    return {
      type: 'function',
      function: {
        name: this.tool.name,
        description: this.tool.description,
        parameters: this.tool.parameters,
      },
    };
  }
}
