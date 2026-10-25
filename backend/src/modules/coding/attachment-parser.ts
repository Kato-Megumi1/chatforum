import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
let active=0;
export async function parseAttachment(input:{operation:'extract'|'render'|'export';kind:string;data?:Buffer;page?:number;text?:string},signal?:AbortSignal):Promise<any> {
  signal?.throwIfAborted();
  if(active>=2)throw new ServiceUnavailableException('文档处理繁忙，请稍后重试');
  // This is a per-file parser resource guard, not a whole Agent task quota.
  const workerPath=existsSync(join(__dirname,'attachment.worker.js'))?join(__dirname,'attachment.worker.js'):join(process.cwd(),'dist/src/modules/coding/attachment.worker.js');
  active++;
  try { return await new Promise((resolve,reject)=>{
    const worker=new Worker(workerPath,{workerData:input,resourceLimits:{maxOldGenerationSizeMb:256},stdout:true,stderr:true});
    // Parser warnings can include untrusted document fragments. Drain without logging them.
    worker.stdout?.resume();worker.stderr?.resume();
    let settled=false;
    const done=(error?:Error,value?:any)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(value);};
    const abort=()=>done(new ServiceUnavailableException('文件处理已停止'));
    const timer=setTimeout(()=>done(new BadRequestException('单文件解析超时，请拆分文档后重试')),30000);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    worker.once('message',m=>{if(m.ok)done(undefined,m.result);else done(new BadRequestException(({TEXT_LIMIT:'提取文字超过20万字符，请拆分文档',PAGE_LIMIT:'PDF超过100页，请拆分文档',DOCX_LIMIT:'Word包结构不支持或解压体积超限',PDF_FONT_MISSING:'PDF导出字体尚未安装',PAGE_RANGE:'PDF页码越界',IMAGE_FORMAT:'仅支持静态PNG/JPEG/WebP'} as Record<string,string>)[m.code]||'文件解析失败，可能损坏、加密或格式不支持'));});
    worker.once('error',()=>done(new BadRequestException('文件解析失败或超出处理资源，请检查文件')));
    worker.once('exit',()=>{if(!settled)done(new BadRequestException('文件处理未完成'));});
  }); } finally {active--;}
}
