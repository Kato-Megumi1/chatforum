import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { ChatRunDto } from '../modules/chat/chat-run.dto';

// class-transformer/ValidateNested traverse children even when ArrayMaxSize
// fails. Enforce transport shape before that traversal, not in the controller.
// These are the existing request capacities, never model/task token quotas.
export class RequestValidationPipe extends ValidationPipe {
  async transform(value:unknown,metadata:ArgumentMetadata){
    if(metadata.type==='body'&&metadata.metatype===ChatRunDto&&value&&typeof value==='object'){
      const body=value as Record<string,unknown>,files=body.attachments;
      if(files!==undefined&&files!==null&&(!Array.isArray(files)||files.length>80||files.some(file=>
        !file||typeof file!=='object'||Array.isArray(file)||
        ['id','revision'].some(key=>file[key]!==undefined&&typeof file[key]!=='number')||
        file.kind!==undefined&&typeof file.kind!=='string')))
        throw new BadRequestException('附件列表格式无效，每条消息最多选择80个附件');
      if(body.enabledSkills!==undefined&&body.enabledSkills!==null&&
        (!Array.isArray(body.enabledSkills)||body.enabledSkills.length>20||body.enabledSkills.some(item=>typeof item!=='string')))
        throw new BadRequestException('工具列表格式无效，最多选择20项');
      if(body.resumeFile!==undefined&&body.resumeFile!==null&&
        (typeof body.resumeFile!=='object'||Array.isArray(body.resumeFile)))
        throw new BadRequestException('文件继续参数格式无效');
    }
    return super.transform(value,metadata);
  }
}
