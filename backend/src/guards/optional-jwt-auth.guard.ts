import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import configuration from '../config/configuration';
import { PrismaService } from '../common/prisma.service';

interface CustomRequest extends Request {
  user?: any;
}

@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService, private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CustomRequest>();
    const [type, token] = request.headers.authorization?.split(' ') ?? [];

    if (type === 'Bearer' && token) {
      try {
        const payload = await this.jwtService.verifyAsync(token, {
          secret: configuration().jwt.accessSecret,
        });
        const user = Number.isInteger(payload.sub) ? await this.prisma.user.findUnique({
          where: { id: payload.sub }, select: { status: true, role: true, authVersion: true },
        }) : null;
        if (user?.status === 'ACTIVE' && (payload.authVersion ?? 0) === user.authVersion) request.user = { ...payload, role: user.role };
      } catch {
        // Token invalid — proceed as unauthenticated
      }
    }

    return true;
  }
}
