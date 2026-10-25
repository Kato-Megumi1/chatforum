import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { ChatRunController } from './chat-run.controller';
import { ChatRunService } from './chat-run.service';

describe('durable task recovery HTTP contract without database or model calls', () => {
  let app: INestApplication;
  const rows=[{id:'10000000-0000-4000-8000-000000000001',status:'RUNNING',createdAt:new Date(1000)}];
  const recovery=jest.fn().mockResolvedValue(rows),get=jest.fn();
  beforeAll(async()=>{
    const module=await Test.createTestingModule({controllers:[ChatRunController],
      providers:[{provide:ChatRunService,useValue:{recovery,get}}]})
      .overrideGuard(JwtAuthGuard).useValue({canActivate(context:any){
        context.switchToHttp().getRequest().user={sub:3,authVersion:2};return true;
      }}).compile();
    app=module.createNestApplication();app.setGlobalPrefix('api');app.useGlobalPipes(new ValidationPipe({transform:true}));await app.init();
  });
  afterAll(async()=>{await app?.close();});
  beforeEach(()=>{recovery.mockClear();get.mockClear();});
  test('static recovery route precedes UUID route and exposes only its allowlisted response',async()=>{
    const response=await request(app.getHttpServer()).get('/api/chat/runs/recovery?conversationId=4').expect(200);
    expect(recovery).toHaveBeenCalledWith(3,4,2);expect(get).not.toHaveBeenCalled();
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.data).toEqual([{...rows[0],createdAt:new Date(1000).toISOString()}]);
    expect(JSON.stringify(response.body)).not.toMatch(/privateState|input|question|content/);
  });
  test.each(['','?conversationId=nope','?conversationId=1.2','?conversationId=1e2'])('missing or invalid query %s fails before service access',async query=>{
    await request(app.getHttpServer()).get('/api/chat/runs/recovery'+query).expect(400);
    expect(recovery).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();
  });
});
