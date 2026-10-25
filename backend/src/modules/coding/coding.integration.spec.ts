import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../common/prisma.service';
import { CodingController } from './coding.controller';
import { CodingService } from './coding.service';
import { AttachmentService } from './attachment.service';
import { RagModelService } from '../agent/rag-model.service';
import { parseAttachment } from './attachment-parser';
import { HttpExceptionFilter } from '../../filters/http-exception.filter';
import { CodingSkill } from '../agent/skills/coding.skill';
import { SkillRegistry } from '../agent/skills/skill.registry';

const suite = process.env.RUN_CODING_INTEGRATION === '1' ? describe : describe.skip;
suite('coding workspace real HTTP and MySQL isolation', () => {
  let app: INestApplication, db: PrismaService, service: CodingService, jwt: JwtService;
  let owner: number, other: number, cid: number, roleId: number, legacyId: number, token: string, otherToken: string;
  const prefix = 'coding_' + randomUUID().slice(0, 8);
  const scope = () => ({ userId: owner, conversationId: cid });
  const binary = (res:any,callback:any) => {const parts:Buffer[]=[];res.on('data',(part:Buffer)=>parts.push(part));res.on('end',()=>callback(null,Buffer.concat(parts)));};
  const http = (method: 'get' | 'post' | 'delete', suffix = '', auth = token, id = cid) => request(app.getHttpServer())[method](`/api/coding/${id}${suffix}`).set('Authorization', 'Bearer ' + auth);
  const propose = (after: string, path = 'main.js', expectedRevision = 1) => service.tool({ action: 'propose', path, expectedRevision, content: after, description: 'Synthetic edit' }, scope()) as Promise<any>;
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test') throw Error('Refusing non-fixture database');
    process.env.JWT_ACCESS_SECRET = 'coding-fixture-only-not-a-real-secret';
    const module = await Test.createTestingModule({ imports: [JwtModule.register({})], controllers: [CodingController], providers: [PrismaService, CodingService, AttachmentService, RagModelService] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    db = app.get(PrismaService); service = app.get(CodingService); jwt = app.get(JwtService);
    const users = await Promise.all([1, 2].map(n => db.user.create({ data: { email: `${prefix}_${n}@example.test`, username: `${prefix}_${n}`, password: 'fixture-not-a-login-hash' } })));
    [owner, other] = users.map(u => u.id);
    [cid, roleId, legacyId] = await Promise.all(['ASSISTANT', 'ROLEPLAY', 'LEGACY'].map(async conversationType => (await db.conversation.create({ data: { userId: owner, title: prefix, conversationType: conversationType as any } })).id));
    token = jwt.sign({ sub: owner }, { secret: process.env.JWT_ACCESS_SECRET }); otherToken = jwt.sign({ sub: other }, { secret: process.env.JWT_ACCESS_SECRET });
  });
  afterAll(async () => {
    if (db && owner) { await db.conversation.deleteMany({ where: { userId: owner, title: prefix } }); await db.user.deleteMany({ where: { id: { in: [owner, other] }, username: { startsWith: prefix } } }); }
    if (app) await app.close();
  });
  test('owner uploads; no cross-user, roleplay, legacy or unauthenticated access', async () => {
    expect((await http('post', '/files').send({ files: [{ path: 'main.js', content: 'globalThis.__must_not_run = 99;\nconst answer = 1;' }] })).status).toBe(201);
    expect((await http('get')).body.data.files[0]).toMatchObject({ path: 'main.js', revision: 1 });
    expect((await http('get', '', otherToken)).status).toBe(403);
    for (const id of [roleId, legacyId]) expect((await http('get', '', token, id)).status).toBe(403);
    expect((await request(app.getHttpServer()).get(`/api/coding/${cid}`)).status).toBe(401);
    expect((await http('post', '/files').send({ userId: other, files: [{ path: 'x.ts', content: '' }] })).status).toBe(400);
  });
  test('text attachment download and independent modified copy remain scoped to owner', async () => {
    expect((await http('post','/files').send({files:[{path:'说明.csv',content:'name,value\na,1'}]})).status).toBe(201);
    const artifact=await service.tool({action:'propose',path:'说明.csv',expectedRevision:1,content:'name,value\na,2',description:'修正数字'},scope()) as any;
    const copy=await http('get','/changes/'+artifact.proposalId);
    expect(copy.status).toBe(200);expect(copy.body.data.after).toBe('name,value\na,2');
    expect((await http('get','/changes/'+artifact.proposalId,otherToken)).status).toBe(403);
    expect((await http('get','/files')).body.data.find(f=>f.path==='说明.csv').content).toBe('name,value\na,1');
    await expect(service.tool({action:'write',path:'说明.csv',content:'overwrite'},scope())).rejects.toThrow();
    await expect(service.tool({action:'read',path:'说明.csv',userId:other},scope())).rejects.toThrow();
  });
  test('binary upload, Chinese filename, PDF/Word download and original preservation enforce ownership', async () => {
    const docx=Buffer.from((await parseAttachment({operation:'export',kind:'docx',text:'合成原始文档'})).data);
    const uploaded=await http('post','/attachments').attach('file',docx,'说明.docx');
    expect(uploaded.status).toBe(201);expect(uploaded.body.data.name).toBe('说明.docx');
    const original=await http('get',`/attachments/${uploaded.body.data.id}/download`).buffer(true).parse(binary);
    expect(original.status).toBe(200);expect(original.headers['content-disposition']).toContain('attachment;');expect(Buffer.from(original.body).equals(docx)).toBe(true);
    expect((await http('get',`/attachments/${uploaded.body.data.id}/download`,otherToken)).status).toBe(403);
    expect((await http('post','/attachments',token,roleId).attach('file',docx,'说明.docx')).status).toBe(403);
    expect((await http('post','/attachments').attach('file',docx,'说明.docx')).status).toBe(409);
    expect((await http('post','/attachments').attach('file',Buffer.from('bad'),'x.pdf')).status).toBe(400);
    expect(await service.tool({action:'read',path:'说明.docx'},scope())).toMatchObject({revision:1,content:expect.stringContaining('合成原始文档')});
    const change=await service.tool({action:'propose',path:'说明.docx',expectedRevision:1,content:'合成修改版',description:'改写'},scope()) as any;
    const modified=await http('get',`/changes/${change.proposalId}/download`).buffer(true).parse(binary);
    expect(modified.status).toBe(200);expect((await parseAttachment({operation:'extract',kind:'docx',data:modified.body})).text).toContain('合成修改版');
    expect((await http('get',`/changes/${change.proposalId}/download`,otherToken)).status).toBe(403);
    expect((await http('post',`/changes/${change.proposalId}/decision`).send({decision:'apply'})).status).toBe(400);
    expect(await service.tool({action:'read',path:'说明.docx'},scope())).toMatchObject({content:expect.stringContaining('合成原始文档')});
    const pdf=await service.tool({action:'propose',path:'输出.pdf',expectedRevision:0,content:'合成PDF内容',description:'生成'},scope()) as any;
    const download=await http('get',`/changes/${pdf.proposalId}/download`).buffer(true).parse(binary);expect(download.status).toBe(200);expect(Buffer.from(download.body).subarray(0,5).toString()).toBe('%PDF-');
  });
  test('read/search carry versions and line numbers; check parses but never executes', async () => {
    expect(await service.tool({ action: 'read', path: 'main.js' }, scope())).toMatchObject({ revision: 1, content: expect.stringContaining('2: const answer') });
    expect(await service.tool({ action: 'search', query: 'answer' }, scope())).toMatchObject({ matches: [{ path: 'main.js', revision: 1, line: 2, text: 'const answer = 1;' }] });
    expect(await service.tool({ action: 'check', path: 'main.js' }, scope())).toMatchObject({ syntaxValid: true, executed: false });
    expect((globalThis as any).__must_not_run).toBeUndefined();
  });
  test('real Agent tool bridge opts in explicitly, preserves JSON, and injects only server scope', async () => {
    SkillRegistry.register(new CodingSkill(service), { name: 'code_workspace', category: '编程', description: 'fixture', enabled: false });
    expect(SkillRegistry.getLangChainTools(undefined, db, scope()).some(t => t.name === 'code_workspace')).toBe(false);
    expect(SkillRegistry.getOpenAIFunctions().some(t => t.function.name === 'code_workspace')).toBe(false);
    const tool = SkillRegistry.getLangChainTools(['code_workspace'], db, scope())[0];
    const result = JSON.parse(await tool.invoke({ action: 'read', path: 'main.js' }));
    expect(result).toMatchObject({ success: true, data: { trust: 'untrusted_code', revision: 1, content: expect.stringContaining('answer') } });
    const otherTool = SkillRegistry.getLangChainTools(['code_workspace'], db, { userId: other, conversationId: cid })[0];
    expect(JSON.parse(await otherTool.invoke({ action: 'list' })).success).toBe(false);
  });
  test('proposal is pending only; duplicates are idempotent; owner review is required', async () => {
    const before = (await service.export(scope()))[0].content, after = before.replace('answer = 1', 'answer = 2');
    const proposal = await propose(after), duplicate = await propose(after);
    expect(proposal.applied).toBe(false); expect(duplicate.proposalId).toBe(proposal.proposalId);
    expect((await service.export(scope()))[0].content).toBe(before);
    const detail = (await http('get', `/changes/${proposal.proposalId}`)).body.data;
    expect(detail).toMatchObject({ before, after, status: 'PENDING', baseRevision: 1 });
    expect((await http('post', `/changes/${proposal.proposalId}/decision`, otherToken).send({ decision: 'apply' })).status).toBe(403);
    expect((await http('post', `/changes/${proposal.proposalId}/decision`).send({ decision: 'run' })).status).toBe(400);
    for (let i = 0; i < 2; i++) expect((await http('post', `/changes/${proposal.proposalId}/decision`).send({ decision: 'apply' })).body.data.status).toBe('APPLIED');
    expect((await service.overview(scope())).files[0].revision).toBe(2);
    expect((await service.export(scope()))[0].content).toBe(after);
  });
  test('concurrent stale proposals cannot overwrite the winner; rejection cannot later apply', async () => {
    const a = await propose('const a=1;', 'main.js', 2), b = await propose('const b=2;', 'main.js', 2);
    const results = await Promise.all([a, b].map(p => http('post', `/changes/${p.proposalId}/decision`).send({ decision: 'apply' })));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect((await service.overview(scope())).files[0].revision).toBe(3);
    const rejected = await propose('const c=3;', 'main.js', 3);
    expect((await http('post', `/changes/${rejected.proposalId}/decision`).send({ decision: 'reject' })).body.data.status).toBe('REJECTED');
    expect((await http('post', `/changes/${rejected.proposalId}/decision`).send({ decision: 'apply' })).status).toBe(409);
  });
  test('imports are atomic, no replacement or unsafe paths; pending new file does not exist before approval', async () => {
    const upload = (files: any[]) => http('post', '/files').send({ files });
    expect((await upload([{ path: 'safe.ts', content: '' }, { path: '../bad.ts', content: '' }])).status).toBe(400);
    expect((await upload([{ path: 'safe.ts', content: '' }, { path: 'main.js', content: '' }])).status).toBe(409);
    expect((await service.overview(scope())).files.map(f => f.path)).toEqual(['main.js','说明.csv','说明.docx']);
    const newFile = await propose('{"ok":true}', 'src/config.json', 0);
    expect((await service.export(scope())).length).toBe(2);
    await service.decide(newFile.proposalId, 'apply', scope());
    expect(await service.tool({ action: 'check', path: 'src/config.json' }, scope())).toMatchObject({ syntaxValid: true, executed: false });
  });
  test('read pagination is bounded and active status is checked afresh', async () => {
    await service.upload({ files: [{ path: 'lines.txt', content: Array.from({ length: 130 }, (_, i) => `line ${i}`).join('\n') }] }, scope());
    expect(await service.tool({ action: 'read', path: 'lines.txt' }, scope())).toMatchObject({ nextLine: 121, totalLines: 130 });
    expect(await service.tool({ action: 'read', path: 'lines.txt', startLine: 121 }, scope())).toMatchObject({ nextLine: null });
    await db.user.update({ where: { id: owner }, data: { status: 'BANNED' } });
    expect((await http('get')).status).toBe(401);
    await expect(service.overview(scope())).rejects.toThrow('无权访问');
    await db.user.update({ where: { id: owner }, data: { status: 'ACTIVE' } });
  });
  test('delete is owner-only, versioned, idempotent and blocked during an active answer', async () => {
    await service.upload({files:[{path:'remove.txt',content:'deletion-only-fixture'}]},scope());
    const file=(await service.overview(scope())).files.find(f=>f.path==='remove.txt')!;
    const target=`/files/${file.id}?kind=text&revision=1`;
    const proposal=await propose('changed','remove.txt');
    expect((await http('delete',target,otherToken)).status).toBe(403);
    for(const id of [roleId,legacyId])expect((await http('delete',target,token,id)).status).toBe(403);
    expect((await request(app.getHttpServer()).delete(`/api/coding/${cid}${target}`)).status).toBe(401);
    expect((await http('delete',`/files/${file.id}?kind=text`)).status).toBe(400);
    expect((await http('delete',target+'&userId='+owner)).status).toBe(400);
    expect((await http('delete',`/files/${file.id}?kind=text&revision=2`)).status).toBe(409);
    const run=await db.chatRun.create({data:{userId:owner,conversationId:cid,requestId:randomUUID(),input:{}}});
    try {
      for(const status of ['QUEUED','RUNNING']){
        await db.chatRun.update({where:{id:run.id},data:{status}});
        expect((await http('delete',target)).status).toBe(409);
      }
    } finally {await db.chatRun.delete({where:{id:run.id}});}
    await db.user.update({where:{id:owner},data:{status:'BANNED'}});
    try {expect((await http('delete',target)).status).toBe(401);}
    finally {await db.user.update({where:{id:owner},data:{status:'ACTIVE'}});}
    expect((await http('delete',target)).body.data).toEqual({deleted:true,removedChanges:1});
    expect((await http('get',`/changes/${proposal.proposalId}`)).status).toBe(404);
    expect((await http('get',`/changes/${proposal.proposalId}/download`)).status).toBe(404);
    expect((await http('post',`/changes/${proposal.proposalId}/decision`).send({decision:'apply'})).status).toBe(404);
    await expect(service.tool({action:'read',path:'remove.txt'},scope())).rejects.toThrow();
    expect(await service.tool({action:'search',query:'deletion-only-fixture'},scope())).toMatchObject({matches:[]});
    expect((await http('delete',target)).body.data.deleted).toBe(false);
    await service.upload({files:[{path:'remove.txt',content:'replacement'}]},scope());
    expect((await http('delete',target)).body.data.deleted).toBe(false);
    expect(await service.tool({action:'read',path:'remove.txt'},scope())).toMatchObject({content:expect.stringContaining('replacement')});
    expect((await service.overview(scope())).files.some(f=>f.path==='main.js')).toBe(true);
  });
  test('deleting a document removes its original and same-name downloadable modifications only',async()=>{
    const docx=Buffer.from((await parseAttachment({operation:'export',kind:'docx',text:'Synthetic delete document'})).data);
    const uploaded=await http('post','/attachments').attach('file',docx,'delete-doc.docx');
    expect(uploaded.status).toBe(201);
    const fileId=uploaded.body.data.id,target=`/files/${fileId}?kind=attachment&revision=1`;
    const proposal=await propose('Synthetic change','delete-doc.docx');
    expect((await http('delete',target,otherToken)).status).toBe(403);
    expect((await http('delete',target)).body.data).toEqual({deleted:true,removedChanges:1});
    expect((await http('get',`/attachments/${fileId}/download`)).status).toBe(404);
    expect((await http('get',`/changes/${proposal.proposalId}/download`)).status).toBe(404);
    await expect(service.tool({action:'read',path:'delete-doc.docx'},scope())).rejects.toThrow();
    expect((await service.overview(scope())).files.some(f=>f.path==='delete-doc.docx')).toBe(false);
    const replacement=await http('post','/attachments').attach('file',docx,'delete-doc.docx');
    expect(replacement.status).toBe(201);expect(replacement.body.data.id).not.toBe(fileId);
    expect((await http('delete',target)).body.data.deleted).toBe(false);
    expect((await http('get',`/attachments/${replacement.body.data.id}/download`)).status).toBe(200);
  });
});
