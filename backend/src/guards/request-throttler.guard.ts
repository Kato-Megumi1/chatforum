import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { verify } from 'jsonwebtoken';

@Injectable()
export class RequestThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const bearer = String(req.headers.authorization || '').match(/^Bearer (.+)$/i)?.[1];
    if (bearer && process.env.JWT_ACCESS_SECRET) {
      try {
        const payload = verify(bearer, process.env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
        if (typeof payload !== 'string' && Number.isSafeInteger(payload.sub as unknown as number))
          return 'user:' + payload.sub;
      } catch { /* untrusted token cannot choose another user's rate-limit bucket */ }
    }
    return 'ip:' + req.ip;
  }
}
