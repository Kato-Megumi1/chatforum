import request from './request';
export interface ChatFile { id:number; path:string; revision:number; kind?:string; bytes?:number; }
export const chatFileKey=(file:ChatFile)=>`${!file.kind||file.kind==='text'?'text':'attachment'}:${file.id}`;
export const chatFileRef=(file:ChatFile)=>({id:file.id,kind:!file.kind||file.kind==='text'?'text':'attachment',revision:file.revision});
export async function fetchChatFile(conversationId:number,file:ChatFile) {
  const binary=file.kind&&file.kind!=='text';
  return request.get<Blob>(`/coding/${conversationId}/${binary?'attachments':'files'}/${file.id}/download`,{
    responseType:'blob',timeout:60000,...(!binary?{params:{revision:file.revision}}:{}),
  });
}
export function deleteChatFile(conversationId:number, file:ChatFile) {
  if (!Number.isSafeInteger(file.id) || file.id < 1) throw Error('文件信息已过期，请刷新文件列表');
  return request.delete<{deleted:boolean;removedChanges:number}>(`/coding/${conversationId}/files/${file.id}`, {
    params:{kind:file.kind && file.kind !== 'text'?'attachment':'text',revision:file.revision},
  });
}
const TEXT_ACCEPT = '.js,.jsx,.ts,.tsx,.cjs,.mjs,.json,.vue,.html,.css,.scss,.md,.txt,.csv,.py,.java,.go,.rs,.sql,.yml,.yaml,.toml';
export const CHAT_FILE_ACCEPT = TEXT_ACCEPT + ',.pdf,.docx,.png,.jpg,.jpeg,.webp';
const isBinary = (name:string) => /\.(pdf|docx|png|jpe?g|webp)$/i.test(name);
export async function uploadChatFiles(conversationId:number, files:File[], onUploaded?:(files:ChatFile[])=>void) {
  if (!files.length || files.length>60) throw Error('请选择1～60个文件');
  for (const f of files) {
    if (!CHAT_FILE_ACCEPT.split(',').some(ext=>f.name.toLowerCase().endsWith(ext))) throw Error('支持图片 PNG/JPEG/WebP、PDF、Word DOCX 和文本/代码。旧版 .doc 请先另存为 .docx。');
    if (f.size > (isBinary(f.name)?20*1024*1024:64000)) throw Error(`${f.name} 超出大小限制：图片/文档20MB，文本/代码64KB`);
  }
  const text = await readChatFiles(files.filter(f=>!isBinary(f.name)));
  let uploaded = 0;
  const saved:ChatFile[]=[];
  try {
    if(text.length){const result=await request.post<{files:ChatFile[]}>(`/coding/${conversationId}/files`,{files:text});saved.push(...result.files);uploaded+=text.length;}
    for(const file of files.filter(f=>isBinary(f.name))){const form=new FormData();form.append('file',file);const result=await request.post<ChatFile&{name:string}>(`/coding/${conversationId}/attachments`,form,{timeout:120000});saved.push({...result,path:result.name,revision:1});uploaded++;}
  } catch(e:any){throw Error(`${uploaded ? `已保存${uploaded}个文件；其余上传中断：` : ''}${e.response?.data?.message||e.message||'上传失败'}`);}
  finally { if(saved.length)onUploaded?.(saved.sort((a,b)=>files.findIndex(f=>f.name===a.path)-files.findIndex(f=>f.name===b.path))); }
  return saved;
}
export async function readChatFiles(files: File[]) {
  if (files.length > 60 || files.some(f => f.size > 64000) || files.reduce((n,f) => n + f.size, 0) > 1000000)
    throw Error('支持 UTF-8 文本/代码：单文件 64KB，最多 60 个，总计 1MB。');
  return Promise.all(files.map(async f => {
    if (!TEXT_ACCEPT.split(',').some(ext => f.name.toLowerCase().endsWith(ext)))
      throw Error('请使用附件上传入口处理图片、PDF、Word');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await f.arrayBuffer());
    if (content.includes('\0')) throw Error('文件不是支持的文本格式。');
    return { path: f.name, content };
  }));
}
export function downloadChatFile(path: string, content: string | Blob) {
  const name = path.split('/').pop() || 'download.txt';
  if (/[\\:\x00-\x1f]/.test(name)) throw Error('文件名无效');
  // Always download as data, not an HTML preview / executable response.
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type: 'application/octet-stream' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
