import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const MAX_TEXT=200000, MAX_PAGES=100;

async function pdf(buffer:Buffer) {
  const loader = await (new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")')());
  const root=dirname(require.resolve('pdfjs-dist/package.json'));
  const task=loader.getDocument({data:new Uint8Array(buffer),isEvalSupported:false,verbosity:0,disableFontFace:true,
    useSystemFonts:false,standardFontDataUrl:join(root,'standard_fonts')+'/',cMapUrl:join(root,'cmaps')+'/',cMapPacked:true});
  try { return {doc:await task.promise,task}; } catch(e) {await task.destroy();throw e;}
}
async function work(input:any) {
  const buffer=Buffer.from(input.data||[]);
  if(input.operation==='export') {
    if(typeof input.text!=='string'||input.text.length>MAX_TEXT)throw Error('TEXT_LIMIT');
    if(input.kind==='docx') {
      const {Document,Paragraph,Packer}=require('docx');
      const document=new Document({sections:[{children:input.text.split('\n').map((text:string)=>new Paragraph({text}))}]});
      return {data:await Packer.toBuffer(document)};
    }
    const PDFDocument=require('pdfkit');
    const target=process.env.CHAT_PDF_FONT || [join(process.env.WINDIR||'C:/Windows','Fonts','msyh.ttc'),'/usr/share/fonts/noto/NotoSansCJK-Regular.ttc','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'].find(p=>existsSync(p));
    if(!target||!existsSync(target))throw Error('PDF_FONT_MISSING');
    return new Promise((resolve,reject)=>{const doc=new PDFDocument({size:'A4',margin:48,autoFirstPage:true}),chunks:Buffer[]=[];let pages=1;
      doc.on('pageAdded',()=>{if(++pages>MAX_PAGES)doc.destroy(Error('PAGE_LIMIT'));});
      doc.on('data',(b:Buffer)=>chunks.push(b));doc.on('error',reject);doc.on('end',()=>resolve({data:Buffer.concat(chunks)}));
      doc.font(target,process.platform==='win32'?'MicrosoftYaHei':'NotoSansCJKsc-Regular').fontSize(11).text(input.text,{lineGap:4});doc.end();});
  }
  if(input.kind==='image') {
    const sharp=require('sharp');
    // Raster attachments only: never let an SVG decoder inspect untrusted input,
    // including the metadata step that precedes the format allowlist.
    sharp.block({operation:['VipsForeignLoadSvg']});
    const image=sharp(buffer,{limitInputPixels:16777216,animated:false});
    const meta=await image.metadata();if(!['png','jpeg','webp'].includes(meta.format)||meta.pages>1)throw Error('IMAGE_FORMAT');
    const rendered=await image.rotate().resize({width:1280,height:1280,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:88}).toBuffer();
    return input.operation==='render'?{data:rendered}:{text:'',pages:[],pageCount:1,needsVision:true};
  }
  if(input.kind==='docx') {
    const Zip=require('adm-zip'), zip=new Zip(buffer),entries=zip.getEntries();
    if(entries.length>2000||!zip.getEntry('word/document.xml')||!zip.getEntry('[Content_Types].xml')||
       entries.reduce((n:number,e:any)=>n+e.header.size,0)>32*1024*1024||entries.some((e:any)=>/vbaProject|\.\.|^\//i.test(e.entryName)))throw Error('DOCX_LIMIT');
    const extracted=await require('mammoth').extractRawText({buffer},{externalFileAccess:false});
    if(extracted.value.length>MAX_TEXT)throw Error('TEXT_LIMIT');
    return {text:extracted.value,pages:[{page:1,text:extracted.value}],pageCount:0,needsVision:false};
  }
  const {doc,task}=await pdf(buffer);
  try {
    if(doc.numPages>MAX_PAGES)throw Error('PAGE_LIMIT');
    if(input.operation==='render') {
      if(!Number.isInteger(input.page)||input.page<1||input.page>doc.numPages)throw Error('PAGE_RANGE');
      const page=await doc.getPage(input.page),base=page.getViewport({scale:1}),scale=Math.min(2,1600/Math.max(base.width,base.height));
      const viewport=page.getViewport({scale});const canvas=doc.canvasFactory.create(Math.ceil(viewport.width),Math.ceil(viewport.height));
      try {await page.render({canvasContext:canvas.context,viewport}).promise;return {data:canvas.canvas.toBuffer('image/png')};}
      finally {doc.canvasFactory.destroy(canvas);}
    }
    const pages=[];let total=0;
    for(let n=1;n<=doc.numPages;n++){const page=await doc.getPage(n),content=await page.getTextContent();
      const text=content.items.map((i:any)=>typeof i.str==='string'?i.str+(i.hasEOL?'\n':' '):'').join('');total+=text.length;
      if(total>MAX_TEXT)throw Error('TEXT_LIMIT');pages.push({page:n,text});page.cleanup();}
    return {text:pages.map(p=>`[第${p.page}页]\n${p.text}`).join('\n\n'),pages,pageCount:doc.numPages,needsVision:pages.some(p=>p.text.trim().length<15)};
  } finally {await task.destroy();}
}
if(!isMainThread) void work(workerData).then(result=>parentPort!.postMessage({ok:true,result})).catch(e=>parentPort!.postMessage({ok:false,code:
  ['TEXT_LIMIT','PAGE_LIMIT','DOCX_LIMIT','PDF_FONT_MISSING','PAGE_RANGE','IMAGE_FORMAT'].includes(e.message)?e.message:'INVALID_DOCUMENT'}));
