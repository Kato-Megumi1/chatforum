import { Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

export interface LoginContext { ip?: string; userAgent?: string }
export async function recordLogin(db: PrismaService, userId: number | null, outcome: string,
  channel: 'WEB' | 'LOCAL_ADMIN', context: LoginContext = {}) {
  try {
    await db.loginEvent.create({ data: { userId, outcome, channel,
      ip: context.ip?.slice(0, 64), userAgent: context.userAgent?.replace(/[\r\n]/g, ' ').slice(0, 190) } });
  } catch {
    // Observability must not break login; never include supplied identifiers or secrets in logs.
    new Logger('LoginAudit').error('Login event persistence failed');
  }
}
