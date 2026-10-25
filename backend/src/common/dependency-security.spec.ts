describe('targeted dependency security patches',()=>{
  test('handlebars patch retains safe string templates and rejects malformed AST values',()=>{
    const handlebars=require('handlebars');
    expect(handlebars.VERSION).toBe('4.7.10');
    expect(handlebars.compile('Hello {{name}}')({name:'<script>'})).toBe('Hello &lt;script&gt;');
    const ast=handlebars.parse('{{#if okay}}Hello{{/if}}');
    // No injected code or executable payload: the fixed validator must reject
    // this type confusion rather than treating a string as an AST array length.
    ast.body[0].program.blockParams={length:'not a number'};
    expect(()=>handlebars.compile(ast)({okay:true})).toThrow();
  });
  test('proxy-addr fixes overly broad IPv4-mapped IPv6 trust matching',()=>{
    const proxyAddr=require('proxy-addr');
    expect(require('proxy-addr/package.json').version).toBe('2.0.8');
    const malformed=proxyAddr.compile('::ffff:10.0.0.0/8');
    expect(malformed('203.0.113.10',0)).toBe(false);
    const valid=proxyAddr.compile('::ffff:10.0.0.0/104');
    expect(valid('10.1.2.3',0)).toBe(true);expect(valid('203.0.113.10',0)).toBe(false);
    const loopback=proxyAddr.compile('loopback');
    expect(loopback('127.0.0.1',0)).toBe(true);expect(loopback('203.0.113.10',0)).toBe(false);
  });
  test('sharp raster decode remains available after the patch',async()=>{
    const sharp=require('sharp');
    expect(sharp.versions.sharp).toBe('0.35.5');
    sharp.block({operation:['VipsForeignLoadSvg']});
    const input=await sharp({create:{width:32,height:24,channels:3,background:'#ffbf80'}}).png().toBuffer();
    const output=await sharp(input).resize({width:16}).jpeg().toBuffer();
    expect(await sharp(output).metadata()).toMatchObject({format:'jpeg',width:16,height:12});
    await expect(sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>')).metadata()).rejects.toThrow();
  });
});
