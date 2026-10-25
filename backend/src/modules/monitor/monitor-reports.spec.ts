import * as request from 'supertest';
import { MonitorService } from './monitor.service';

describe('local-only forum report administration',()=>{
  const token='a'.repeat(64),csrf='b'.repeat(64),origin='http://127.0.0.1:8091';
  const fixture=()=>{
    const user={id:9,username:'fixture_admin',email:'fixture@example.test',role:'ADMIN',status:'ACTIVE',authVersion:2};
    const db={user:{findUnique:jest.fn().mockResolvedValue(user)}},redis={get:jest.fn().mockResolvedValue(JSON.stringify({userId:9,csrf,authVersion:2})),del:jest.fn()};
    const reports={adminList:jest.fn().mockResolvedValue({rows:[]}),decide:jest.fn().mockResolvedValue({ok:true}),
      decideAppeal:jest.fn().mockResolvedValue({ok:true}),context:jest.fn().mockResolvedValue({content:'fixture content'})};
    const app=new MonitorService(db as any,redis as any,undefined,undefined,undefined,undefined,reports as any).createApp(8091);
    return{app,db,redis,reports};
  };
  const write=(app:any,path='/reports/30/decision')=>request(app).post('/ops-api'+path).set('Host','127.0.0.1:8091')
    .set('Origin',origin).set('Cookie','cf_local_ops='+token).set('X-Ops-CSRF',csrf).send({action:'DISMISS',reason:'fixture'});
  test('normal/public JWT and missing independent session cannot access any report operation',async()=>{
    const f=fixture();f.redis.get.mockResolvedValue(null);
    await request(f.app).get('/ops-api/reports').set('Host','127.0.0.1:8091').set('Authorization','Bearer public-jwt').expect(401);
    expect(f.reports.adminList).not.toHaveBeenCalled();
  });
  test('Host, Origin, CSRF, role and current authVersion checks all remain enforced',async()=>{
    const f=fixture();await write(f.app).set('Host','evil.example:8091').expect(403);
    await write(f.app).set('Origin','https://evil.example').expect(403);await write(f.app).set('X-Ops-CSRF','').expect(403);
    f.db.user.findUnique.mockResolvedValue({id:9,status:'ACTIVE',role:'USER',authVersion:2} as any);await write(f.app).expect(403);
    f.db.user.findUnique.mockResolvedValue({id:9,status:'ACTIVE',role:'ADMIN',authVersion:3} as any);await write(f.app).expect(401);
    expect(f.reports.decide).not.toHaveBeenCalled();
  });
  test('the validated local session version is passed into every report service operation',async()=>{
    const f=fixture();await write(f.app).expect(200);await write(f.app,'/report-appeals/40/decision').expect(200);
    await request(f.app).get('/ops-api/reports/30/context').set('Host','127.0.0.1:8091').set('Cookie','cf_local_ops='+token).expect(200);
    expect(f.reports.decide).toHaveBeenCalledWith(9,2,30,expect.any(Object),expect.anything());
    expect(f.reports.decideAppeal).toHaveBeenCalledWith(9,2,40,expect.any(Object),expect.anything());
    expect(f.reports.context).toHaveBeenCalledWith(9,2,30);
  });
});
