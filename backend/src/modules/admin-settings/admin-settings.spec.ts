import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';
import * as dns from 'dns/promises';
import { AdminSettingsService, decryptSettings, encryptSettings, emailAddress, smtpHost } from './admin-settings.service';
import { MailService, publicAddress, publicSmtpAddress } from './mail.service';
const mockSend = jest.fn().mockImplementation(async message => ({ messageId: 'fixture-only', accepted: [message.to.address] })), mockClose = jest.fn();
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: mockSend, close: mockClose })) }));
const smtp = { enabled: true, host: 'smtp.example.com', port: 465, user: 'sender@example.com', from: 'sender@example.com', password: 'fixture-authorization-code' };
const testTempRoot = resolve(__dirname, '../../../../.local/test-tmp');
describe('private administration settings and SMTP security (no real deliveries)', () => {
  let dir: string, oldSecret: string | undefined, oldQwen: string | undefined, oldDeepseek: string | undefined, oldDefault: string | undefined;
  beforeEach(async () => {
    oldSecret = process.env.JWT_REFRESH_SECRET; oldQwen = process.env.QWEN_CHAT_ENABLED;
    oldDeepseek = process.env.DEEPSEEK_CHAT_ENABLED; oldDefault = process.env.CHAT_DEFAULT_MODEL;
    process.env.JWT_REFRESH_SECRET = 'fixture-refresh-secret-32-bytes-or-longer';
    await mkdir(testTempRoot, { recursive: true }); dir = await mkdtemp(join(testTempRoot, 'cf-admin-settings-test-'));
    mockSend.mockClear(); mockClose.mockClear(); require('nodemailer').createTransport.mockClear();
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as any);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (dir && resolve(dir).startsWith(testTempRoot + sep)) await rm(dir, { recursive: true, force: true });
    for (const [name, value] of [['JWT_REFRESH_SECRET',oldSecret],['QWEN_CHAT_ENABLED',oldQwen],['DEEPSEEK_CHAT_ENABLED',oldDeepseek],['CHAT_DEFAULT_MODEL',oldDefault]])
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  function service() { const instance = new AdminSettingsService(); (instance as any).file = join(dir, 'admin-settings.enc'); return instance; }
  test('authenticated encryption rejects tampering, wrong keys and invalid key strength', () => {
    const encrypted = encryptSettings({ authorization: smtp.password }, process.env.JWT_REFRESH_SECRET!);
    expect(encrypted).not.toContain(smtp.password);
    expect(decryptSettings(encrypted, process.env.JWT_REFRESH_SECRET!)).toEqual({ authorization: smtp.password });
    expect(() => decryptSettings(encrypted, 'another-fixture-secret-32-bytes-or-longer')).toThrow();
    const envelope = JSON.parse(encrypted); envelope.tag = Buffer.alloc(16).toString('base64');
    expect(() => decryptSettings(JSON.stringify(envelope), process.env.JWT_REFRESH_SECRET!)).toThrow();
    expect(() => encryptSettings({}, 'short')).toThrow();
  });
  test('SMTP password never appears in public snapshots; omitted password preserves encrypted credential', async () => {
    const settings = service(); await settings.saveSmtp(smtp);
    const snapshot = settings.snapshot(); expect(snapshot.smtp.passwordConfigured).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(smtp.password);
    expect(await readFile((settings as any).file, 'utf8')).not.toContain(smtp.password);
    const { password, ...remaining } = smtp; await settings.saveSmtp({ ...remaining, port: 587 });
    expect(settings.smtp()?.password).toBe(password);
    const restored = service(); await restored.onModuleInit(); expect(restored.smtp()?.password).toBe(password);
  });
  test('invalid encrypted data locks changes and SMTP without erasing the file', async () => {
    const settings = service(); await writeFile((settings as any).file, 'fixture-corrupted-data');
    await settings.onModuleInit(); expect(settings.snapshot().locked).toBe(true); expect(settings.smtp()).toBeNull();
    await expect(settings.saveSmtp(smtp)).rejects.toThrow('加密配置');
    expect(await readFile((settings as any).file, 'utf8')).toBe('fixture-corrupted-data');
  });
  test('email/hostname and address validation rejects headers, IP endpoints and private/metadata addresses', () => {
    expect(emailAddress('someone@example.com')).toBe(true); expect(emailAddress('x@example.com\r\nBcc:other@example.com')).toBe(false);
    expect(smtpHost('smtp.example.com')).toBe(true); expect(smtpHost('127.0.0.1')).toBe(false); expect(smtpHost('smtp.internal')).toBe(false);
    for (const value of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::','2001::1','2001:2::1','3fff::1']) expect(publicAddress(value)).toBe(false);
    expect(publicAddress('8.8.8.8')).toBe(true); expect(publicAddress('2001:4860:4860::8888')).toBe(true);
  });
  test('SMTP pins validated DNS, enforces TLS and disables file/URL reads for password recovery', async () => {
    const settings = service(); await settings.saveSmtp(smtp); const mail = new MailService(settings);
    expect(await mail.isReady()).toBe(true); await mail.sendPasswordResetCode('member@example.com', '123456');
    const options = require('nodemailer').createTransport.mock.calls.at(-1)[0];
    expect(options).toMatchObject({ host: '8.8.8.8', secure: true, requireTLS: true, disableFileAccess: true, disableUrlAccess: true,
      tls: { servername: smtp.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' } });
    expect(mockSend.mock.calls[0][0].text).toContain('123456'); expect(mockClose).toHaveBeenCalled();
    (dns.lookup as jest.Mock).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(mail.sendPasswordResetCode('member@example.com', '123456')).rejects.toThrow('邮件发送失败');
  });
  test('test mail accepts any one valid recipient while retaining the fixed sender, subject and body', async () => {
    const settings = service(); await settings.saveSmtp(smtp); const mail = new MailService(settings);
    for (const to of ['outside@example.net', 'another+test@example.org']) expect(await mail.sendTest(to)).toEqual({ ok: true });
    expect(mockSend).toHaveBeenCalledTimes(2);
    for (const [index, to] of ['outside@example.net', 'another+test@example.org'].entries()) {
      expect(mockSend.mock.calls[index][0]).toEqual({ from: { name: 'ChatForum', address: smtp.from }, to: { address: to },
        subject: 'ChatForum 邮件配置测试', text: '这是一封由本机管理台主动发送的测试邮件。收到这封邮件表示SMTP投递已经完成。',
        disableFileAccess: true, disableUrlAccess: true });
    }
  });
  test('test mail rejects multiple recipients, header injection and structured address objects before DNS or transport', async () => {
    const settings = service(); await settings.saveSmtp(smtp); const mail = new MailService(settings);
    for (const to of ['', 'first@example.com,second@example.com', 'first@example.com;second@example.com',
      'First <first@example.com>', 'first@example.com\r\nBcc:second@example.com', 'first@example.com\n', 'first@example.com\r',
      'first@example.com\0', ' first@example.com ', ['first@example.com'], { address: 'first@example.com' }, null, 7])
      await expect(mail.sendTest(to as any)).rejects.toMatchObject({ status: 400 });
    expect(dns.lookup).not.toHaveBeenCalled(); expect(require('nodemailer').createTransport).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  });
  test('valid recipient with missing or disabled SMTP reports unavailable rather than a recipient restriction', async () => {
    const settings = service(), mail = new MailService(settings);
    await expect(mail.sendTest('outside@example.net')).rejects.toMatchObject({ status: 503, message: '邮件服务尚未配置' });
    await settings.saveSmtp({ ...smtp, enabled: false });
    await expect(mail.sendTest('outside@example.net')).rejects.toMatchObject({ status: 503, message: '邮件服务尚未配置' });
    expect(dns.lookup).not.toHaveBeenCalled(); expect(require('nodemailer').createTransport).not.toHaveBeenCalled();
  });
  test.each([465, 587])('test mail preserves DNS pinning and certificate-checked TLS on port %i', async port => {
    const settings = service(); await settings.saveSmtp({ ...smtp, port });
    await new MailService(settings).sendTest('outside@example.net');
    expect(dns.lookup).toHaveBeenCalledWith(smtp.host, { all: true, verbatim: true });
    expect(require('nodemailer').createTransport.mock.calls[0][0]).toMatchObject({ host: '8.8.8.8', port,
      secure: port === 465, requireTLS: true, ignoreTLS: false,
      tls: { servername: smtp.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
  test('mixed public/fake-IP or public/private IPv6 DNS answers remain blocked, including fake-IP subnet boundaries', async () => {
    expect(publicAddress('198.17.255.255')).toBe(true); expect(publicAddress('198.20.0.1')).toBe(true);
    for (const address of ['198.18.0.0', '198.19.255.255', 'fe80::1', '::ffff:127.0.0.1']) {
      (dns.lookup as jest.Mock).mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]);
      await expect(publicSmtpAddress(smtp.host)).rejects.toMatchObject({ status: 400, message: 'SMTP域名不能指向本机、内网或保留地址' });
    }
    (dns.lookup as jest.Mock).mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '2408:4001:10::1', family: 6 }]);
    expect(await publicSmtpAddress(smtp.host)).toBe('8.8.8.8');
    expect(require('nodemailer').createTransport).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  });
  test('bad SMTP options and model credentials/client-defined endpoint are rejected', async () => {
    const settings = service(); await expect(settings.saveSmtp({ ...smtp, port: 25 })).rejects.toThrow();
    await expect(settings.saveSmtp({ ...smtp, password: 'bad\nsecret' })).rejects.toThrow();
    await expect(settings.saveModels({ defaultModelId: 'custom', enabled: {} })).rejects.toThrow();
    await expect(settings.saveModels({ defaultModelId: 'qwen3.8-max', enabled: { 'qwen3.8-max': true, 'deepseek-v4-pro': false }, endpoint: 'http://private' })).rejects.toThrow();
  });
});
