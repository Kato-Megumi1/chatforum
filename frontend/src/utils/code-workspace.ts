export function codeDiff(before: string, after: string) {
  const left = before.split('\n'), right = after.split('\n');
  let start = 0, end = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  while (end < left.length - start && end < right.length - start && left[left.length - end - 1] === right[right.length - end - 1]) end++;
  return { startLine: start + 1, removed: left.slice(start, left.length - end).join('\n'), added: right.slice(start, right.length - end).join('\n') };
}

// Small uncompressed UTF-8 ZIP writer. Code is downloaded as data, never run or previewed as HTML.
export function codeArchive(files: Array<{ path: string; content: string }>) {
  const encode = new TextEncoder(), records: Uint8Array[] = [], directory: Uint8Array[] = [];
  let offset = 0, centralSize = 0;
  const crc32 = (bytes: Uint8Array) => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i=0;i<8;i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  for (const file of files) {
    if (file.path.startsWith('/') || /[\\:\x00-\x1f]/.test(file.path) || file.path.split('/').some(s=>!s||s==='.'||s==='..')) throw Error('无效的下载文件路径');
    const name = encode.encode(file.path), body = encode.encode(file.content), crc = crc32(body);
    const local = new Uint8Array(30 + name.length), l = new DataView(local.buffer);
    l.setUint32(0,0x04034b50,true); l.setUint16(4,20,true); l.setUint16(6,0x800,true); l.setUint32(14,crc,true);
    l.setUint32(18,body.length,true); l.setUint32(22,body.length,true); l.setUint16(26,name.length,true); local.set(name,30);
    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
    c.setUint32(0,0x02014b50,true); c.setUint16(4,20,true); c.setUint16(6,20,true); c.setUint16(8,0x800,true);
    c.setUint32(16,crc,true); c.setUint32(20,body.length,true); c.setUint32(24,body.length,true); c.setUint16(28,name.length,true); c.setUint32(42,offset,true); central.set(name,46);
    records.push(local,body); directory.push(central); offset += local.length + body.length; centralSize += central.length;
  }
  const end = new Uint8Array(22), e = new DataView(end.buffer); e.setUint32(0,0x06054b50,true); e.setUint16(8,files.length,true); e.setUint16(10,files.length,true); e.setUint32(12,centralSize,true); e.setUint32(16,offset,true);
  return new Blob([...records,...directory,end] as BlobPart[],{type:'application/zip'});
}
