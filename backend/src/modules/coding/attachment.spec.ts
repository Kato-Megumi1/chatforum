import { attachmentType, documentPath } from './attachment.policy';
import { parseAttachment } from './attachment-parser';
import { RagModelService } from '../agent/rag-model.service';
import { withChatModel } from '../chat/chat-models';

describe('attachment parsing and real binary export', () => {
  test('validates names, magic bytes and rejects old Word/executable formats', () => {
    for(const name of ['../a.pdf','C:\\a.pdf','a.doc','a.exe','.hidden.pdf','a\u202e.pdf']) expect(()=>documentPath(name)).toThrow();
    expect(()=>attachmentType('a.pdf',Buffer.from('not a pdf'))).toThrow();
    expect(attachmentType('a.pdf',Buffer.from('%PDF-1.7\n'))).toMatchObject({kind:'pdf'});
  });
  test('DOCX is a real ZIP document and roundtrips Chinese text', async () => {
    const output=await parseAttachment({operation:'export',kind:'docx',text:'合成附件\n你好，这是修改后的正文。'});
    const data=Buffer.from(output.data);expect(data.subarray(0,2).toString()).toBe('PK');
    expect(await parseAttachment({operation:'extract',kind:'docx',data})).toMatchObject({text:expect.stringContaining('修改后的正文'),needsVision:false});
  });
  test('PDF exports real Chinese text, preserves page reference and renders scan input', async () => {
    const output=await parseAttachment({operation:'export',kind:'pdf',text:'合成PDF附件\n修改后内容 42'});
    const data=Buffer.from(output.data);expect(data.subarray(0,5).toString()).toBe('%PDF-');
    const parsed=await parseAttachment({operation:'extract',kind:'pdf',data});expect(parsed.pageCount).toBe(1);expect(parsed.text).toContain('42');
    const image=await parseAttachment({operation:'render',kind:'pdf',data,page:1});expect(Buffer.from(image.data).subarray(1,4).toString()).toBe('PNG');
    await expect(parseAttachment({operation:'render',kind:'pdf',data,page:2})).rejects.toThrow('页码');
  });
  test('image is decoded not trusted by MIME, and damaged ZIP is rejected', async () => {
    const png=await require('sharp')({create:{width:32,height:32,channels:3,background:'#328bcf'}}).png().toBuffer();
    expect(await parseAttachment({operation:'extract',kind:'image',data:png})).toMatchObject({needsVision:true});
    const normalized=await parseAttachment({operation:'render',kind:'image',data:png});expect(Buffer.from(normalized.data)[0]).toBe(255);
    await expect(parseAttachment({operation:'extract',kind:'image',data:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')})).rejects.toThrow();
    await expect(parseAttachment({operation:'extract',kind:'docx',data:Buffer.from('PKbroken')})).rejects.toThrow();
  });
  test('DeepSeek image input cannot silently use another model', async () => {
    const fetchSpy=jest.spyOn(global,'fetch');
    await expect(withChatModel({id:'deepseek-v4-pro',label:'fixture',defaultModel:'fixture',defaultApiBase:'https://invalid.test',defaultApiKey:'fixture',bodyOptions:{},pricingPrefix:'TEST'},()=>new RagModelService().vision(Buffer.from('image'),'image/png','test'))).rejects.toThrow('Qwen');
    expect(fetchSpy).not.toHaveBeenCalled();fetchSpy.mockRestore();
  });
});
