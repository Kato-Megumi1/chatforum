<template>
  <div v-if="files.length" class="message-attachments" aria-label="消息附件">
    <button v-for="file in files" :key="chatFileKey(file)" :disabled="busy" :aria-label="`下载消息附件 ${file.path}`" :title="file.path" @click="download(file)">
      <el-icon><PictureIcon v-if="file.kind==='image'"/><Document v-else/></el-icon><span>{{ file.path }}</span>
    </button>
  </div>
</template>
<script setup lang="ts">
import {ref,onBeforeUnmount} from 'vue';
import {ElMessage} from 'element-plus';
import {Picture as PictureIcon} from '@element-plus/icons-vue';
import {chatFileKey,fetchChatFile,downloadChatFile,type ChatFile} from '@/utils/chat-files';
import {useUserStore} from '@/stores/user';
const props=defineProps<{conversationId:number;files:ChatFile[]}>();
const busy=ref(false),user=useUserStore();let active=true;
onBeforeUnmount(()=>active=false);
async function download(file:ChatFile){
  const owner=user.user?.id,cid=props.conversationId;if(busy.value||!owner)return;busy.value=true;
  try{const data=await fetchChatFile(cid,file);if(active&&owner===user.user?.id&&cid===props.conversationId)downloadChatFile(file.path,data);}
  catch(e:any){if(active&&owner===user.user?.id)ElMessage.error(e.message||'附件已删除或暂时无法下载');}
  finally{busy.value=false;}
}
</script>
<style scoped>
.message-attachments{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin:8px 0;}
button{display:flex;align-items:center;gap:9px;max-width:min(280px,100%);padding:12px 14px;border:1px solid #c7d5e7;border-radius:13px;background:#fff;color:#324e75;cursor:pointer;font-family:inherit;font-size:13px;line-height:1.5;}
button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}button .el-icon{flex-shrink:0;font-size:20px;color:#587aa6;}
button:hover{background:#eef4fc;}button:focus-visible{outline:2px solid #6084b7;outline-offset:2px;}
</style>
