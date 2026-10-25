import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface MessageAnchor { id: number; createdAt: Date }
function key() {
  const secret=process.env.JWT_ACCESS_SECRET;
  if (!secret || secret.length<24) throw new ServiceUnavailableException('会话分页暂不可用');
  return secret;
}
export function encodeMessageCursor(userId:number,conversationId:number,anchor:MessageAnchor) {
  const data=Buffer.from(JSON.stringify({v:1,u:userId,c:conversationId,i:anchor.id,t:anchor.createdAt.toISOString()})).toString('base64url');
  return data+'.'+createHmac('sha256',key()).update('chat-history-v1:'+data).digest('base64url');
}
export function decodeMessageCursor(value:string,userId:number,conversationId:number):MessageAnchor {
  try {
    if(typeof value!=='string'||value.length>600||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))throw Error();
    const [data,signature]=value.split('.'),actual=Buffer.from(signature,'base64url');
    const expected=createHmac('sha256',key()).update('chat-history-v1:'+data).digest();
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();
    const parsed=JSON.parse(Buffer.from(data,'base64url').toString('utf8')),createdAt=new Date(parsed.t);
    if(parsed.v!==1||parsed.u!==userId||parsed.c!==conversationId||!Number.isSafeInteger(parsed.i)||parsed.i<1||
      !Number.isFinite(createdAt.getTime())||createdAt.toISOString()!==parsed.t)throw Error();
    return{id:parsed.i,createdAt};
  } catch { throw new BadRequestException('会话游标无效，请重新打开对话'); }
}
