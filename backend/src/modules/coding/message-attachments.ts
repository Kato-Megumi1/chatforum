import { ConflictException } from '@nestjs/common';
import { z } from 'zod';

export const messageFileRefs = z.array(z.object({
  id:z.number().int().positive(), kind:z.enum(['text','attachment']), revision:z.number().int().positive(),
}).strict()).max(80);
export type MessageFileRef = Required<z.infer<typeof messageFileRefs>[number]>;
export interface MessageFile { id:number; path:string; kind:string; revision:number; bytes:number; }
export const fileKey = (f:{id:number;kind?:string}) => `${!f.kind || f.kind==='text'?'text':'attachment'}:${f.id}`;
export function resolveMessageFiles(catalog:MessageFile[], input:unknown):MessageFile[] {
  const parsed=messageFileRefs.safeParse(input);
  if(!parsed.success)throw new ConflictException('消息附件参数无效');
  const refs=parsed.data as MessageFileRef[];
  const keys=refs.map(fileKey);
  if(new Set(keys).size!==keys.length)throw new ConflictException('同一条消息不能重复添加同一个附件');
  return refs.map(ref=>{
    const file=catalog.find(f=>fileKey(f)===fileKey(ref));
    if(!file || file.revision!==ref.revision)throw new ConflictException('附件已删除、更新或不属于此会话，请重新选择');
    return file;
  });
}
// Only for server-saved message metadata. No raw content, URLs or client filenames enter this manifest.
export function savedMessageFiles(metadata:unknown):MessageFile[] {
  const schema=z.array(z.object({id:z.number().int().positive(),path:z.string().max(180),kind:z.enum(['text','image','pdf','docx']),revision:z.number().int().positive(),bytes:z.number().int().nonnegative()})).max(80);
  return (schema.safeParse((metadata as any)?.messageAttachments).data || []) as MessageFile[];
}
