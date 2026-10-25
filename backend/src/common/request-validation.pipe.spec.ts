import { Test } from '@nestjs/testing';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import request = require('supertest');
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatRunController } from '../modules/chat/chat-run.controller';
import { ChatRunService } from '../modules/chat/chat-run.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RequestValidationPipe } from './request-validation.pipe';

describe('chat transport bounds before nested DTO transformation',()=>{
  let app:INestApplication;
  const create=jest.fn(async()=>({id:randomUUID(),status:'QUEUED'}));
  const body=()=>({requestId:randomUUID(),conversationId:4,question:'synthetic',mode:'normal'});
  beforeAll(async()=>{
    const module=await Test.createTestingModule({controllers:[ChatRunController],providers:[{provide:ChatRunService,useValue:{create}}]})
      .overrideGuard(JwtAuthGuard).useValue({canActivate:(context:ExecutionContext)=>{
        context.switchToHttp().getRequest().user={sub:321};return true;
      }}).compile();
    app=module.createNestApplication({logger:false});
    app.useGlobalPipes(new RequestValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.init();
  });
  afterAll(()=>app?.close());
  afterEach(()=>{jest.restoreAllMocks();create.mockClear();});
  test('oversized and nested-list attachments fail before the parent transform and cannot create a task',async()=>{
    const transform=jest.spyOn(ValidationPipe.prototype,'transform');
    for(const attachments of [Array.from({length:5000},()=>({})),[Array.from({length:1000},()=>({}))],
      [{id:[],kind:'text',revision:1}]])
      await request(app.getHttpServer()).post('/chat/runs').send({...body(),attachments}).expect(400);
    expect(transform.mock.calls.filter(([,metadata])=>metadata.type==='body')).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post('/chat/runs').send(body()).expect(201);
    expect(create).toHaveBeenCalledTimes(1);
  });
  test('existing capacities and strict DTO checks remain: 80 valid files pass, bad entries and unknown fields fail',async()=>{
    const attachments=Array.from({length:80},(_,index)=>({id:index+1,kind:'text',revision:1}));
    await request(app.getHttpServer()).post('/chat/runs').send({...body(),attachments}).expect(201);
    expect(create).toHaveBeenCalledTimes(1);create.mockClear();
    for(const addition of [{attachments:[{}]},{attachments:[{id:1,kind:'not-a-file',revision:1}]},
      {enabledSkills:Array.from({length:21},()=> 'calculator')},{resumeFile:[]},{modelApiKey:'untrusted'}])
      await request(app.getHttpServer()).post('/chat/runs').send({...body(),...addition}).expect(400);
    expect(create).not.toHaveBeenCalled();
  });
  test('production main registers the bounded pipe before any nested DTO validation',()=>{
    const main=readFileSync(join(__dirname,'../main.ts'),'utf8');
    expect(main).toContain('app.useGlobalPipes(new RequestValidationPipe(');
  });
});
