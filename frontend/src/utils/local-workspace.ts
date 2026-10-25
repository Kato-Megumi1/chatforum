import { shallowRef, ref } from 'vue';
import request from './request';
import { LocalCodeFiles } from './local-code-files';
type Connection = { id: string; token: string; name: string; conversationId: number; ownerId: number; files: LocalCodeFiles };
export const localWorkspace = shallowRef<Connection | null>(null);
export const localWorkspaceError = ref('');
export const localActivity = ref<Array<{ id: string; action: string; path: string; status: string }>>([]);
export const supportsLocalWorkspace = () => window.isSecureContext && typeof (window as any).showDirectoryPicker === 'function';
const url = (c: Connection) => `/coding/${c.conversationId}/local/${c.id}`;
const config = (c: Connection) => ({ headers: { 'X-Workspace-Token': c.token } });
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
export function localConnection(conversationId?: number, ownerId?: number) {
  const c = localWorkspace.value;
  return c && c.conversationId === conversationId && c.ownerId === ownerId ? c : null;
}
export function disconnectLocalWorkspace(notifyServer = true) {
  generation++; clearTimeout(timer);
  const c = localWorkspace.value; localWorkspace.value = null;
  if (c && notifyServer) void request.delete(url(c), config(c)).catch(() => undefined);
}
export async function connectLocalFolder(root: any, conversationId: number, ownerId: number) {
  disconnectLocalWorkspace(); localWorkspaceError.value = ''; localActivity.value = [];
  const stamp = generation;
  const info = await request.post<{ id: string; token: string; name: string }>(`/coding/${conversationId}/local`, { name: root.name });
  if (stamp !== generation) return;
  const files = new LocalCodeFiles(root, () => localWorkspace.value?.id === info.id && generation === stamp);
  const c: Connection = { ...info, conversationId, ownerId, files };
  localWorkspace.value = c;
  const completed = new Map<string, any>();
  async function poll() {
    if (localWorkspace.value !== c || stamp !== generation) return;
    try {
      const { operation: op } = await request.get<any>(url(c), config(c));
      if (localWorkspace.value !== c || stamp !== generation) return;
      if (op) {
        if (op.workspaceId !== c.id || op.expiresAt < Date.now()) throw Error('收到已失效的文件操作');
        let result = completed.get(op.id);
        if (!result) {
          const authorized = async () => {
            if (localWorkspace.value !== c || stamp !== generation) throw Error('工作区已断开');
            await request.post(url(c) + `/operations/${op.id}/authorize`, {}, config(c));
            if (localWorkspace.value !== c || stamp !== generation) throw Error('工作区已断开');
          };
          try { await authorized(); result = { success: true, data: await files.execute(op.args, authorized) }; }
          catch (e: any) { result = { success: false, error: (e.message || '文件操作失败').slice(0, 300) }; }
          completed.set(op.id, result); // Retrying an acknowledgment never replays a write.
          if (completed.size > 100) completed.delete(completed.keys().next().value!);
          localActivity.value = [{ id: op.id, action: op.args.action, path: op.args.path || '', status: result.success ? (result.data.saved ? '已保存到本机' : '已完成') : result.error }, ...localActivity.value].slice(0, 50);
        }
        if (localWorkspace.value !== c || stamp !== generation) return;
        await request.post(url(c) + `/operations/${op.id}`, result, config(c));
      }
      if (localWorkspace.value === c) timer = setTimeout(poll, 1500);
    } catch {
      if (localWorkspace.value !== c) return;
      localWorkspaceError.value = '工作区连接中断。请检查本机文件后重新选择目录；未确认的写入不会自动重试。';
      disconnectLocalWorkspace();
    }
  }
  void poll();
}
