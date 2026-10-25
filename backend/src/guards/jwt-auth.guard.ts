import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import configuration from '../config/configuration';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService, private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException();
    }

    try {
      const payload = await this.jwtService.verifyAsync(
        token,
        { secret: configuration().jwt.accessSecret }
      );
      if (!Number.isInteger(payload.sub)) throw new UnauthorizedException();
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub },
        select: { id: true, status: true, role: true, authVersion: true } });
      if (!user || user.status !== 'ACTIVE' || (payload.authVersion ?? 0) !== user.authVersion) throw new UnauthorizedException();
      request.user = { ...payload, role: user.role };
    } catch {
      throw new UnauthorizedException();
    }

    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
