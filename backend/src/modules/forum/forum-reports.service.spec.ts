import { ForumReportsService } from './forum-reports.service';

describe('forum report and appeal state machine',()=>{
  const requestId='10000000-0000-4000-8000-000000000001';
  const make=()=>{
    const post:any={id:10,userId:2,title:'fixture post',content:'fixture content',status:'APPROVED',revision:3,commentCount:1};
    const comment:any={id:20,postId:10,userId:2,content:'fixture comment',status:'ACTIVE',updatedAt:new Date(1000)};
    let report:any,appeal:any;
    const users:any={1:{id:1,status:'ACTIVE',role:'USER',authVersion:1},2:{id:2,status:'ACTIVE',role:'USER',authVersion:1},
      3:{id:3,status:'ACTIVE',role:'USER',authVersion:1},9:{id:9,status:'ACTIVE',role:'ADMIN',authVersion:1}};
    const tx:any={$queryRaw:jest.fn().mockResolvedValue([]),user:{findUnique:jest.fn(async({where}:any)=>users[where.id])},
      post:{findFirst:jest.fn(async({where}:any)=>where.id===post.id&&(!where.status||where.status===post.status)?{...post}:null),
        findUnique:jest.fn(async()=>({...post})),update:jest.fn(async({data}:any)=>{if(data.commentCount?.increment)post.commentCount++;
          if(data.commentCount?.decrement)post.commentCount--;return post;}),updateMany:jest.fn(async({where,data}:any)=>{
          if(where.revision!==post.revision||where.status!==post.status)return{count:0};post.status=data.status;post.revision++;return{count:1};})},
      comment:{findFirst:jest.fn(async({where}:any)=>where.id===comment.id&&(!where.status||where.status===comment.status)&&
        (!where.updatedAt||where.updatedAt.getTime()===comment.updatedAt.getTime())?{...comment}:null),
        findUnique:jest.fn(async()=>({...comment})),updateMany:jest.fn(async({where,data}:any)=>{
          if(where.status!==comment.status||where.updatedAt?.getTime()!==comment.updatedAt.getTime())return{count:0};
          comment.status=data.status;comment.updatedAt=new Date(comment.updatedAt.getTime()+1);return{count:1};})},
      report:{findUnique:jest.fn(async({where}:any)=>where.id?report:report?.clientRequestId===where.reporterId_clientRequestId?.clientRequestId?report:null),
        findFirst:jest.fn(async({where}:any)=>report&&Object.keys(where).every(k=>report[k]===where[k])?{...report,appeal}:null),
        count:jest.fn().mockResolvedValue(0),findMany:jest.fn().mockResolvedValue([]),
        create:jest.fn(async({data}:any)=>{report={id:30,status:'PENDING',revision:1,createdAt:new Date(),...data};return report;}),
        update:jest.fn(async({data}:any)=>{for(const[k,v]of Object.entries(data))report[k]=typeof v==='object'&&v&&'increment'in v?report[k]+(v as any).increment:v;return report;})},
      reportAppeal:{create:jest.fn(async({data}:any)=>{appeal={id:40,status:'PENDING',revision:1,...data};return appeal;}),
        findUnique:jest.fn(async()=>appeal?{...appeal,report}:null),update:jest.fn(async({data}:any)=>{Object.assign(appeal,data);return appeal;})},
      operationLog:{create:jest.fn()},notification:{create:jest.fn()}};
    const db:any={...tx,$transaction:jest.fn(async(fn:any)=>fn(tx))},events={append:jest.fn()};
    const service=new ForumReportsService(db,events as any);
    return{service,tx,db,events,post,comment,users,report:()=>report,appeal:()=>appeal};
  };
  const reportInput=(type:'POST'|'COMMENT'='POST')=>({requestId,type,targetId:type==='POST'?10:20,reason:'垃圾广告',detail:'fixture reason'});
  const decision={action:'HIDE',expectedRevision:1,confirmation:'30',reason:'核对后违反社区规则'};
  test('creating a post report is idempotent and never automatically hides content',async()=>{
    const f=make();await f.service.create(1,1,reportInput());await f.service.create(1,1,reportInput());
    expect(f.tx.report.create).toHaveBeenCalledTimes(1);expect(f.post.status).toBe('APPROVED');expect(f.events.append).not.toHaveBeenCalled();
    await expect(f.service.create(1,1,{...reportInput(),detail:'changed'})).rejects.toThrow('请求编号');
  });
  test('comment reports bind the parent post FK and exact comment version',async()=>{
    const f=make();await f.service.create(1,1,reportInput('COMMENT'));
    expect(f.report()).toMatchObject({targetId:10,postId:10,commentId:20,targetUserId:2,targetRevision:3,targetUpdatedAt:new Date(1000)});
  });
  test('current ACTIVE/version are authoritative and self/private targets cannot be reported',async()=>{
    const f=make();await expect(f.service.create(1,0,reportInput())).rejects.toThrow('登录状态');
    f.users[1].status='BANNED';await expect(f.service.mine(1,1)).rejects.toThrow('登录状态');f.users[1].status='ACTIVE';
    await expect(f.service.create(2,1,reportInput())).rejects.toThrow('自己的');
    f.post.status='REJECTED';await expect(f.service.create(1,1,reportInput())).rejects.toThrow('不可举报');
  });
  test('normal users and stale administrators cannot process reports',async()=>{
    const f=make();await f.service.create(1,1,reportInput());
    await expect(f.service.decide(1,1,30,decision)).rejects.toThrow('管理员');
    await expect(f.service.decide(9,0,30,decision)).rejects.toThrow('登录状态');
    expect(f.post.status).toBe('APPROVED');
  });
  test('report processing uses target revision and emits one durable visibility event with audit',async()=>{
    const f=make();await f.service.create(1,1,reportInput());await f.service.decide(9,1,30,decision);await f.service.decide(9,1,30,decision);
    expect(f.post).toMatchObject({status:'REJECTED',revision:4});expect(f.report()).toMatchObject({status:'RESOLVED',targetRevision:4,decision:'HIDE'});
    expect(f.events.append).toHaveBeenCalledTimes(1);expect(f.events.append.mock.calls[0][1]).toMatchObject({kind:'POST_HIDDEN',postId:10,postRevision:4});
    expect(f.tx.operationLog.create).toHaveBeenCalledTimes(1);expect(f.tx.notification.create).toHaveBeenCalledTimes(2);
  });
  test('stale report or changed target is rejected instead of hiding a newer version',async()=>{
    const f=make();await f.service.create(1,1,reportInput());
    await expect(f.service.decide(9,1,30,{...decision,expectedRevision:2})).rejects.toThrow('新版本');
    f.post.revision++;await expect(f.service.decide(9,1,30,decision)).rejects.toThrow('已改变');expect(f.events.append).not.toHaveBeenCalled();
  });
  test('dismissing a report keeps the original visible and does not send author a false penalty',async()=>{
    const f=make();await f.service.create(1,1,reportInput());await f.service.decide(9,1,30,{...decision,action:'DISMISS'});
    expect(f.post.status).toBe('APPROVED');expect(f.report().status).toBe('REJECTED');expect(f.events.append).not.toHaveBeenCalled();
    expect(f.tx.notification.create).toHaveBeenCalledTimes(1);
  });
  test('only the affected author may appeal, once, without gaining reporter details',async()=>{
    const f=make();await f.service.create(1,1,reportInput());await f.service.decide(9,1,30,decision);
    await expect(f.service.appeal(3,1,30,{expectedRevision:2,reason:'request'})).rejects.toThrow('不存在');
    await f.service.appeal(2,1,30,{expectedRevision:2,reason:'请求复核'});await f.service.appeal(2,1,30,{expectedRevision:2,reason:'请求复核'});
    expect(f.tx.reportAppeal.create).toHaveBeenCalledTimes(1);
    await f.service.decisions(2,1);const selected=f.tx.report.findMany.mock.calls[0][0].select;
    expect(selected).not.toHaveProperty('reporter');expect(selected).not.toHaveProperty('reporterId');expect(selected).not.toHaveProperty('reason');
  });
  test('accepted appeal restores the exact hidden version through forum events',async()=>{
    const f=make();await f.service.create(1,1,reportInput());await f.service.decide(9,1,30,decision);
    await f.service.appeal(2,1,30,{expectedRevision:2,reason:'请求复核'});
    await f.service.decideAppeal(9,1,40,{action:'ACCEPT',expectedRevision:1,confirmation:'40',reason:'复核后恢复'});
    expect(f.post).toMatchObject({status:'APPROVED',revision:5});expect(f.report().decision).toBe('RESTORED');
    expect(f.events.append.mock.calls[1][1]).toMatchObject({kind:'POST_APPROVED',postRevision:5});
  });
  test('comment hide/restore counts exactly once and stale later moderation cannot be undone',async()=>{
    const f=make();await f.service.create(1,1,reportInput('COMMENT'));await f.service.decide(9,1,30,decision);
    expect(f.comment.status).toBe('DELETED');expect(f.post.commentCount).toBe(0);
    await f.service.appeal(2,1,30,{expectedRevision:2,reason:'请求复核'});f.comment.updatedAt=new Date(5000);
    await expect(f.service.decideAppeal(9,1,40,{action:'ACCEPT',expectedRevision:1,confirmation:'40',reason:'复核后恢复'})).rejects.toThrow('不能恢复');
    expect(f.post.commentCount).toBe(0);expect(f.comment.status).toBe('DELETED');
  });
  test('a parent post edit is not treated as an edit to the separately versioned comment',async()=>{
    const f=make();await f.service.create(1,1,reportInput('COMMENT'));f.post.revision=4;
    await f.service.decide(9,1,30,decision);await f.service.appeal(2,1,30,{expectedRevision:2,reason:'请求复核'});
    f.post.revision=5;await f.service.decideAppeal(9,1,40,{action:'ACCEPT',expectedRevision:1,confirmation:'40',reason:'复核后恢复'});
    expect(f.comment.status).toBe('ACTIVE');expect(f.post.commentCount).toBe(1);
    expect(f.events.append.mock.calls[1][1]).toMatchObject({kind:'COMMENT_RESTORED',postRevision:5});
  });
  test('USER targets, invalid IDs and anonymous requests never enter the transaction',async()=>{
    const f=make();await expect(f.service.create(1,1,{...reportInput(),type:'USER'} as any)).rejects.toThrow('举报参数');
    await expect(f.service.mine(1,1,{limit:500})).rejects.toThrow('分页');
    await expect(f.service.decide(9,1,30,{...decision,confirmation:'wrong'})).rejects.toThrow('确认编号');
    expect(f.tx.report.create).not.toHaveBeenCalled();
  });
  test('deleted source content leaves a report that can be closed, never guessed or restored',async()=>{
    const f=make();await f.service.create(1,1,reportInput());f.report().postId=null;
    f.tx.post.findUnique.mockResolvedValue(null);
    await expect(f.service.context(9,1,30)).rejects.toThrow('不存在');
    await expect(f.service.decide(9,1,30,decision)).rejects.toThrow('已改变');
    await f.service.decide(9,1,30,{...decision,action:'DISMISS',reason:'原内容已由作者删除'});
    expect(f.report()).toMatchObject({id:30,targetId:10,postId:null,status:'REJECTED'});
    expect(f.events.append).not.toHaveBeenCalled();
  });
});
