import { Test } from '@nestjs/testing';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import request = require('supertest');
import { CodingController } from './coding.controller';
import { CodingService } from './coding.service';
import { AttachmentService } from './attachment.service';
import { importFiles } from './coding.policy';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';

describe('bounded public code import before recursive schema validation',()=>{
  let app:INestApplication;
  const upload=jest.fn(async()=>({imported:1}));
  beforeAll(async()=>{
    const module=await Test.createTestingModule({controllers:[CodingController],providers:[
      {provide:CodingService,useValue:{upload}},{provide:AttachmentService,useValue:{}},
    ]}).overrideGuard(JwtAuthGuard).useValue({canActivate:(context:ExecutionContext)=>{
      context.switchToHttp().getRequest().user={sub:321};return true;
    }}).compile();
    app=module.createNestApplication({logger:false});await app.init();
  });
  afterAll(()=>app?.close());
  afterEach(()=>{jest.restoreAllMocks();upload.mockClear();});
  test('an oversized invalid JSON batch is rejected before any per-file Zod traversal or service call',async()=>{
    const parse=jest.spyOn(importFiles,'safeParse');
    await request(app.getHttpServer()).post('/coding/4/files').send({files:Array.from({length:5000},()=>({}))}).expect(400);
    expect(parse).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();
    const live=await request(app.getHttpServer()).post('/coding/4/files').send({files:[{path:'main.js',content:'const value = 1;'}]}).expect(201);
    expect(live.body.data).toEqual({imported:1});expect(parse).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith({files:[{path:'main.js',content:'const value = 1;'}]},{userId:321,conversationId:4});
  });
  test('the existing 1 to 60 file contract remains exact and malformed batches never reach persistence',async()=>{
    const parse=jest.spyOn(importFiles,'safeParse');
    for(const files of [[],{},null,Array.from({length:61},()=>({path:'a.txt',content:''}))])
      await request(app.getHttpServer()).post('/coding/4/files').send({files}).expect(400);
    expect(parse).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post('/coding/4/files').send({files:[{}]}).expect(400);
    expect(parse).toHaveBeenCalledTimes(1);expect(upload).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post('/coding/4/files').send({files:Array.from({length:60},(_,index)=>({path:`file${index}.txt`,content:'fixture'}))}).expect(201);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
