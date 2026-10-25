import { ConversationFrame } from '../agent/conversation-memory.policy';
import { currentChatModel } from '../chat/chat-models';
import { CodingService } from './coding.service';
import { fileKey } from './message-attachments';

// File references are resolved by the server, not reinterpreted as tool permissions by the model.
export function focusedFiles(files:NonNullable<ConversationFrame['messageFiles']>) {
  if(files.current.length)return files.current;
  return (files.previous?.files || []).filter(f=>f.available && files.library.some(l=>fileKey(l)===fileKey(f)&&l.revision===f.revision));
}
export async function prepareFileTurn(frame:ConversationFrame,coding:CodingService,refs:unknown,skills:string[]|undefined,signal:AbortSignal) {
  if(frame.memory.personaKey!=='assistant')return skills;
  const files=await coding.messageContext(frame.toolScope,refs);
  // Give delegated page/image reads the original task, not just an optional tool-generated keyword.
  let length=0;
  const history=frame.history.slice(-12).map(m=>({role:m.role,content:m.content.slice(0,1200)})).reverse().filter(m=>{length+=m.content.length;return length<=6000;}).reverse();
  frame.toolScope.fileQuestionContext={question:frame.fileResume?.originalQuestion || frame.question,history};
  if(!skills?.includes('code_workspace')&&!files.previous&&!files.current.length)return skills;
  frame.messageFiles=files;
  if(currentChatModel().id==='qwen3.8-max')frame.inlineImages=await coding.inlineImages(focusedFiles(files),{...frame.toolScope,signal});
  return [...new Set([...(skills||[]),'code_workspace'])];
}
