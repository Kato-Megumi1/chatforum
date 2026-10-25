import { BadRequestException, ConflictException, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import { join } from 'path';
import { CHAT_MODEL_IDS, publicChatModels } from '../chat/chat-models';

export interface SmtpSettings { enabled: boolean; host: string; port: number; user: string; from: string; password: string; }
export interface ModelSettings { defaultModelId: string; enabled: Record<string, boolean>; }
interface StoredSettings { version: 1; smtp: SmtpSettings; models: ModelSettings; }
const PURPOSE = 'chatforum/admin-settings/v1';
export const emailAddress = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 &&
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/.test(value);
export function smtpHost(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(value) &&
    !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(value) && !/^metadata\./i.test(value) &&
    value.split('.').every(part => part.length > 0 && part.length <= 63 && !part.startsWith('-') && !part.endsWith('-'));
}
function key(secret: string) {
  if (!secret || secret.length < 32) throw new ServiceUnavailableException('管理配置加密服务未就绪');
  return Buffer.from(hkdfSync('sha256', secret, 'chatforum/settings-key-derivation', PURPOSE, 32));
}
export function encryptSettings(value: unknown, secret: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  cipher.setAAD(Buffer.from(PURPOSE));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}
export function decryptSettings(value: string, secret: string): unknown {
  const input = JSON.parse(value);
  if (input.version !== 1 || typeof input.iv !== 'string' || typeof input.tag !== 'string' || typeof input.data !== 'string') throw Error('Invalid settings envelope');
  const iv = Buffer.from(input.iv, 'base64'), tag = Buffer.from(input.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw Error('Invalid settings envelope');
  const cipher = createDecipheriv('aes-256-gcm', key(secret), iv); cipher.setAAD(Buffer.from(PURPOSE)); cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(input.data, 'base64')), cipher.final()]).toString('utf8'));
}

@Injectable()
export class AdminSettingsService implements OnModuleInit {
  private readonly logger = new Logger(AdminSettingsService.name);
  private value: StoredSettings = { version: 1, smtp: { enabled: false, host: '', port: 465, user: '', from: '', password: '' },
    models: { defaultModelId: publicChatModels().defaultModelId, enabled: Object.fromEntries(CHAT_MODEL_IDS.map(id =>
      [id, process.env[id === 'deepseek-v4-pro' ? 'DEEPSEEK_CHAT_ENABLED' : 'QWEN_CHAT_ENABLED'] !== 'false'])) } };
  private locked = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file = join(process.cwd(), 'storage', 'admin-settings.enc');
  async onModuleInit() {
    try {
      const stat = await fs.lstat(this.file);
      if (stat.isSymbolicLink() || stat.size > 131072) throw Error('Invalid settings file');
      const value = decryptSettings(await fs.readFile(this.file, 'utf8'), process.env.JWT_REFRESH_SECRET || '') as StoredSettings;
      if (value?.version !== 1) throw Error('Invalid settings version');
      const smtp = this.validateSmtp(value.smtp, false), models = this.validateModels(value.models, false);
      this.value = { version: 1, smtp, models }; this.applyModels();
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      this.locked = true;
      process.env.DEEPSEEK_CHAT_ENABLED = process.env.QWEN_CHAT_ENABLED = 'false';
      this.logger.error('Encrypted administration settings could not be loaded; updates, mail and model calls remain disabled');
    }
  }
  snapshot() {
    const { password, ...smtp } = this.value.smtp;
    return { locked: this.locked, smtp: { ...smtp, passwordConfigured: !!password },
      models: { ...this.value.models, enabled: { ...this.value.models.enabled }, catalog: publicChatModels().models } };
  }
  smtp(): SmtpSettings | null { return !this.locked && this.value.smtp.enabled ? { ...this.value.smtp } : null; }
  private applyModels() {
    process.env.CHAT_DEFAULT_MODEL = this.value.models.defaultModelId;
    for (const id of CHAT_MODEL_IDS) process.env[id === 'deepseek-v4-pro' ? 'DEEPSEEK_CHAT_ENABLED' : 'QWEN_CHAT_ENABLED'] = String(this.value.models.enabled[id]);
  }
  private validateModels(input: any, requireAvailable = true): ModelSettings {
    if (!input || Object.keys(input).some(k => !['defaultModelId', 'enabled'].includes(k)) || !CHAT_MODEL_IDS.includes(input.defaultModelId) ||
      !input.enabled || Object.keys(input.enabled).some(k => !CHAT_MODEL_IDS.includes(k as any)) ||
      CHAT_MODEL_IDS.some(id => typeof input.enabled[id] !== 'boolean') || !input.enabled[input.defaultModelId])
      throw new BadRequestException('模型配置无效，默认模型必须为启用的白名单模型');
    if (requireAvailable && !publicChatModels().models.find(m => m.id === input.defaultModelId)?.configured)
      throw new BadRequestException('默认模型尚未配置服务端凭据');
    return { defaultModelId: input.defaultModelId, enabled: Object.fromEntries(CHAT_MODEL_IDS.map(id => [id, input.enabled[id]])) };
  }
  private validateSmtp(input: any, retain = true): SmtpSettings {
    if (!input || Object.keys(input).some(k => !['enabled', 'host', 'port', 'user', 'from', 'password'].includes(k)) || typeof input.enabled !== 'boolean')
      throw new BadRequestException('邮件配置无效');
    const result = { enabled: input.enabled, host: String(input.host || '').trim().toLowerCase(), port: input.port,
      user: String(input.user || '').trim(), from: String(input.from || '').trim(),
      password: input.password === undefined && retain ? this.value.smtp.password : input.password };
    if (typeof result.password !== 'string' || result.password.length > 512 || /[\r\n\0]/.test(result.password) ||
      ![465, 587].includes(result.port) || result.host && !smtpHost(result.host) || result.user && !emailAddress(result.user) || result.from && !emailAddress(result.from) ||
      result.enabled && (!result.host || !result.user || !result.from || !result.password)) throw new BadRequestException('请输入公网SMTP域名、465或587端口、有效邮箱及授权码');
    return result;
  }
  saveSmtp(input: unknown) { return this.update(() => ({ ...this.value, smtp: this.validateSmtp(input) })); }
  saveModels(input: unknown) { return this.update(() => ({ ...this.value, models: this.validateModels(input) })); }
  private update(change: () => StoredSettings) {
    const operation = this.queue.then(async () => {
      if (this.locked) throw new ConflictException('加密配置无法读取，请先由本机维护者恢复配置文件或原加密凭据');
      const next = change(), encrypted = encryptSettings(next, process.env.JWT_REFRESH_SECRET || '');
      const temp = this.file + '.' + randomUUID() + '.tmp';
      try {
        await fs.mkdir(join(process.cwd(), 'storage'), { recursive: true });
        const previous = await fs.lstat(this.file).catch((error: any) => { if (error.code !== 'ENOENT') throw error; return null; });
        if (previous?.isSymbolicLink()) throw Error('Invalid settings target');
        await fs.writeFile(temp, encrypted, { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, this.file); await fs.chmod(this.file, 0o600);
      } catch { throw new ServiceUnavailableException('管理配置保存失败，原配置未主动清除'); }
      finally { await fs.unlink(temp).catch(() => undefined); }
      this.value = next; this.applyModels(); return this.snapshot();
    });
    this.queue = operation.catch(() => undefined); return operation;
  }
}
