import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';
import { AdminSettingsService, emailAddress, smtpHost } from './admin-settings.service';
const nodemailer = require('nodemailer');
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
  ['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
// IPv6 is accepted only within the global unicast block, except documentation space.
const documentation = new BlockList(); documentation.addSubnet('2001:db8::', 32, 'ipv6');
documentation.addSubnet('2001::', 32, 'ipv6'); documentation.addSubnet('2001:2::', 48, 'ipv6');
documentation.addSubnet('2001:10::', 28, 'ipv6'); documentation.addSubnet('2001:20::', 28, 'ipv6'); documentation.addSubnet('3fff::', 20, 'ipv6');
documentation.addSubnet('2002::', 16, 'ipv6');
export function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !documentation.check(address, 'ipv6');
}
export async function publicSmtpAddress(host: string) {
  if (!smtpHost(host)) throw new BadRequestException('仅允许公网SMTP域名');
  let timer: NodeJS.Timeout | undefined;
  const addresses = await Promise.race([lookup(host, { all: true, verbatim: true }), new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('DNS deadline')), 5000); timer.unref();
  })]).catch(() => { throw new ServiceUnavailableException('SMTP域名解析失败'); }).finally(() => { if (timer) clearTimeout(timer); });
  if (!addresses.length || addresses.length > 16 || addresses.some(a => !publicAddress(a.address))) throw new BadRequestException('SMTP域名不能指向本机、内网或保留地址');
  return addresses[0].address;
}
@Injectable()
export class MailService {
  private active = 0;
  constructor(private readonly settings: AdminSettingsService) {}
  async isReady() { const smtp = this.settings.smtp(); return !!(smtp?.host && smtp.user && smtp.password && smtp.from); }
  async validateHost(host: string) { await publicSmtpAddress(host); }
  async sendPasswordResetCode(to: string, code: string) {
    if (!/^\d{6}$/.test(code)) throw new BadRequestException('验证码格式无效');
    return this.send(to, 'ChatForum 密码重置验证码', `你的验证码是：${code}\n\n验证码将在10分钟内失效。请勿将验证码交给他人。若非本人操作，请忽略此邮件。`);
  }
  // Only the independent, authenticated local administrator route calls this method.
  // A test is one fixed message to one validated address, never caller-defined content.
  async sendTest(to: string) {
    if (!emailAddress(to)) throw new BadRequestException('请输入一个有效的测试收件邮箱');
    await this.send(to, 'ChatForum 邮件配置测试', '这是一封由本机管理台主动发送的测试邮件。收到这封邮件表示SMTP投递已经完成。');
    return { ok: true };
  }
  private async send(to: string, subject: string, text: string) {
    if (!emailAddress(to)) throw new BadRequestException('邮箱格式无效');
    const smtp = this.settings.smtp(); if (!smtp) throw new ServiceUnavailableException('邮件服务尚未配置');
    if (this.active >= 4) throw new ServiceUnavailableException('邮件服务繁忙，请稍后重试');
    this.active++;
    let transport: any;
    try {
      // Pin the validated address; retain the original hostname for TLS certificate checking.
      const address = await publicSmtpAddress(smtp.host);
      transport = nodemailer.createTransport({ host: address, port: smtp.port, secure: smtp.port === 465,
        requireTLS: true, ignoreTLS: false, auth: { user: smtp.user, pass: smtp.password },
        tls: { servername: smtp.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
        disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
      const result = await transport.sendMail({ from: { name: 'ChatForum', address: smtp.from }, to: { address: to }, subject, text,
        disableFileAccess: true, disableUrlAccess: true });
      if (!result?.accepted?.some((value: unknown) => typeof value === 'string' && value.toLowerCase() === to.toLowerCase()))
        throw new Error('No recipient accepted');
    } catch { throw new ServiceUnavailableException('邮件发送失败，请检查SMTP配置或稍后重试'); }
    finally { this.active--; transport?.close(); }
  }
}
