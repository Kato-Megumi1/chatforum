import { BadRequestException } from '@nestjs/common';

export const ATTACHMENT_LIMITS = { fileBytes: 20 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, files: 20, pages: 100, textChars: 200000 };
export const documentPath = (name: string) => {
  if (!name || name.length > 180 || name !== name.normalize('NFC') || /[\\/:<>"|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name) ||
      name.startsWith('.') || /[ .]$/.test(name) || !/\.(pdf|docx|png|jpe?g|webp)$/i.test(name))
    throw new BadRequestException('请选择 PDF、DOCX、PNG、JPEG 或 WebP 文件，文件名不能包含路径');
  return name;
};
export function attachmentType(name:string, bytes:Buffer) {
  documentPath(name);
  if (!bytes.length || bytes.length > ATTACHMENT_LIMITS.fileBytes) throw new BadRequestException('附件不能为空且单文件不超过20MB');
  const ext=name.split('.').pop()!.toLowerCase();
  if(ext==='pdf' && bytes.subarray(0,5).toString()==='%PDF-') return {kind:'pdf',mime:'application/pdf'};
  if(ext==='docx' && bytes[0]===0x50&&bytes[1]===0x4b) return {kind:'docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
  if(ext==='png' && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {kind:'image',mime:'image/png'};
  if(['jpg','jpeg'].includes(ext) && bytes[0]===255&&bytes[1]===216&&bytes[2]===255) return {kind:'image',mime:'image/jpeg'};
  if(ext==='webp' && bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP') return {kind:'image',mime:'image/webp'};
  throw new BadRequestException('文件内容与扩展名不匹配，或格式暂不支持');
}
