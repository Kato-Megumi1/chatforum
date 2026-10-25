import { Body, Controller, Get, HttpCode, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import * as zlib from 'node:zlib';
import { json, urlencoded } from 'express';

// Real Nest/Express parsing, but no application module, database, accounts,
// settings file or external requests. These routes are deliberately public.
@Controller()
class BodyFixtureController {
  @Post('echo') @HttpCode(200) echo(@Body() body: unknown) { return body; }
  @Get('ready') ready() { return { alive: true }; }
}

function send(app:INestApplication,body:Buffer,encoding:string,type='application/json') {
  return new Promise<{status:number;text:string}>((resolve,reject)=>{
    const port=(app.getHttpServer().address() as AddressInfo).port;
    const request=httpRequest({host:'127.0.0.1',port,path:'/echo',method:'POST',headers:{
      'Content-Type':type,'Content-Encoding':encoding,'Content-Length':body.length,
    }},response=>{
      let text='';response.setEncoding('utf8');response.on('data',part=>text+=part);
      response.on('end',()=>resolve({status:response.statusCode!,text}));response.on('error',reject);
    });
    request.setTimeout(3000,()=>request.destroy(new Error('Fixture request timed out')));
    request.on('error',reject);request.end(body);
  });
}

describe('the public request-parser dependency is patched',()=>{
  test('both Express and Nest platform resolve exactly the compatible 1.20.9 release',()=>{
    for(const dependency of ['express','@nestjs/platform-express']) {
      const resolved=createRequire(require.resolve(dependency));
      expect(resolved('body-parser/package.json').version).toBe('1.20.9');
    }
  });
});

describe.each([true,false])('public compressed request parsing (production middleware: %s)',custom=>{
  let app:INestApplication;
  beforeAll(async()=>{
    expect(require('body-parser/package.json').version).toBe('1.20.9');
    const module=await Test.createTestingModule({controllers:[BodyFixtureController]}).compile();
    app=module.createNestApplication({logger:false});
    if(custom){app.use(json({limit:'2mb'}));app.use(urlencoded({extended:true,limit:'2mb'}));}
    await app.listen(0,'127.0.0.1');
  });
  afterAll(async()=>{await app?.close();});
  test.each(['gzip','deflate'])('normal %s JSON and forms still parse',async encoding=>{
    const compress=encoding==='gzip'?zlib.gzipSync:zlib.deflateSync;
    const jsonResult=await send(app,compress(Buffer.from(JSON.stringify({message:'仅用于请求解析回归'}))),encoding);
    expect(jsonResult.status).toBe(200);expect(JSON.parse(jsonResult.text)).toEqual({message:'仅用于请求解析回归'});
    const form=await send(app,compress(Buffer.from('message=fixture&nested%5Bvalue%5D=kept')),encoding,'application/x-www-form-urlencoded');
    expect(form.status).toBe(200);expect(JSON.parse(form.text)).toEqual({message:'fixture',nested:{value:'kept'}});
  });
  test('invalid and trailing compressed bytes do not crash the parser or strand the next request',async()=>{
    const malformed=await send(app,Buffer.from('not a gzip stream'),'gzip');expect(malformed.status).toBe(400);
    const compressed=zlib.gzipSync(Buffer.from('{"message":"small benign fixture"}'));
    const trailing=await send(app,Buffer.concat([compressed,Buffer.from('trailing fixture bytes')]),'gzip');
    // A decoder may reject the extra frame before completing; never accept a
    // server error or a socket/process failure as an expected result.
    expect([200,400]).toContain(trailing.status);
    expect((await send(app,zlib.gzipSync(Buffer.from('{"message":"still available"}')),'gzip')).status).toBe(200);
  });
  test('unsupported encoding remains a client error',async()=>{
    expect((await send(app,Buffer.from('{}'),'unsupported-fixture')).status).toBe(415);
    expect((await send(app,Buffer.from('{"message":"still available"}'),'identity')).status).toBe(200);
  });
});

describe('compressed decoder cleanup after a successful public parse',()=>{
  test('detaches and destroys the completed decoder and safely consumes a late decoder error',async()=>{
    // Deterministic lifecycle fixture for CVE-2026-111181: raw-body removes its
    // own error listener before next(). The patched parser must retain safe
    // cleanup even if a decoder reports another error after successful parsing.
    const request:any=new PassThrough(),response:any={};
    request.headers={'content-encoding':'gzip','content-type':'application/json','content-length':'19'};
    request.method='POST';
    const decoder=new PassThrough(),unpipe=jest.spyOn(request,'unpipe');
    const zlibModule=require('node:zlib');
    const gunzip=Object.getOwnPropertyDescriptor(zlibModule,'createGunzip')!;
    Object.defineProperty(zlibModule,'createGunzip',{...gunzip,value:()=>decoder});
    try {
      const finished=new Promise<void>((resolve,reject)=>{
        json()(request,response,(error?:unknown)=>error?reject(error):resolve());
        // PassThrough stands in only for the decoder; request bytes stay tiny.
        request.end('{"message":"okay"}');
      });
      await finished;
      expect(request.body).toEqual({message:'okay'});expect(unpipe).toHaveBeenCalledWith(decoder);
      expect(decoder.destroyed).toBe(true);expect(decoder.listenerCount('error')).toBeGreaterThan(0);
      expect(()=>decoder.emit('error',new Error('late synthetic decoder error'))).not.toThrow();
    } finally {Object.defineProperty(zlibModule,'createGunzip',gunzip);unpipe.mockRestore();request.destroy();decoder.destroy();}
  });
});
