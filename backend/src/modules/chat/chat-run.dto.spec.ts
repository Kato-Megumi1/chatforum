import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ChatRunDto } from './chat-run.dto';

describe('chat turn switches accept booleans only',()=>{
  const base={requestId:'01baf51e-37d0-4cd4-a3dd-447d1534d9dc',conversationId:4,question:'fixture',mode:'normal'};
  const errors=(extra:Record<string,unknown>)=>validateSync(plainToInstance(ChatRunDto,{...base,...extra}),
    {whitelist:true,forbidNonWhitelisted:true});
  test.each([undefined,true,false])('deep thinking and web search allow %s without coercion',value=>{
    expect(errors({deepThinking:value,webSearch:value})).toEqual([]);
  });
  test.each([null,'true','false',0,1,{},[]])('untrusted switch value %j is rejected',value=>{
    const result=errors({deepThinking:value,webSearch:value});
    expect(result.map(error=>error.property)).toEqual(expect.arrayContaining(['deepThinking','webSearch']));
  });
  test('switches do not admit provider parameters, credentials, internal generation flags or client-supplied history',()=>{
    const result=errors({deepThinking:true,webSearch:true,enable_thinking:true,thinking:{type:'enabled'},
      apiKey:'fixture-only',endpoint:'https://invalid.test',generation:{deepThinking:true},history:[]});
    expect(result.map(error=>error.property)).toEqual(expect.arrayContaining(['enable_thinking','thinking','apiKey','endpoint','generation','history']));
  });
});
