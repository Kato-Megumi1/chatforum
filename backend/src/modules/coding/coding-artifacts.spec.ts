import { CodingSkill } from '../agent/skills/coding.skill';
import { codePath } from './coding.policy';
describe('download artifacts are only server-produced proposals', () => {
  test('tracks successful proposals, deduplicates IDs and rejects retired local scope', async () => {
    const coding={tool:jest.fn().mockResolvedValue({proposalId:8,path:'notes.md',status:'PENDING'})};
    const skill = new CodingSkill(coding as any), context={userId:1,conversationId:2,fileArtifacts:[]};
    await skill.execute({action:'propose'},context);await skill.execute({action:'propose'},context);
    expect(context.fileArtifacts).toEqual([{changeId:8,path:'notes.md'}]);
    expect((await skill.execute({action:'read'},{...context,codingWorkspaceId:'retired'})).success).toBe(false);
    expect(coding.tool).toHaveBeenCalledTimes(2);
  });
  test('CSV supported; paths, secrets and binary attachments still rejected', () => {
    expect(codePath('表格.csv')).toBe('表格.csv');
    for(const path of ['../x.txt','.env','image.png','report.pdf','C:/x.md']) expect(()=>codePath(path)).toThrow();
  });
});
