import { EventEmitter } from 'node:events';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { ChatRunController } from '../chat/chat-run.controller';

describe('credential concurrency and stream revocation boundaries', () => {
  test('login cannot promote a bcrypt-verified old record to the new password version', async () => {
    const password = 'Fixture old password', hashed = await bcrypt.hash(password, 4);
    const db: any = { user: { findUnique: jest.fn().mockResolvedValueOnce({ id: 1, role: 'USER', status: 'ACTIVE', password: hashed, authVersion: 0 })
      .mockResolvedValueOnce({ status: 'ACTIVE', authVersion: 1 }) }, loginEvent: { create: jest.fn() } };
    const redis: any = { getClient: () => ({ set: jest.fn().mockResolvedValue(null) }), set: jest.fn() };
    const jwt: any = { signAsync: jest.fn().mockResolvedValue('fixture-token') };
    await expect(new AuthService(db, jwt, redis).login({ email: 'fixture@example.test', password })).rejects.toThrow('Authentication changed');
    expect(jwt.signAsync.mock.calls.every(([payload]) => payload.authVersion === 0)).toBe(true); expect(redis.set).not.toHaveBeenCalled();
  });
  test('missing DB version fails closed and older JWT is only version zero', async () => {
    const jwt: any = { verifyAsync: jest.fn().mockResolvedValue({ sub: 1, role: 'ADMIN' }) }, db: any = { user: { findUnique: jest.fn().mockResolvedValue({ id: 1, role: 'USER', status: 'ACTIVE', authVersion: 0 }) } };
    const req: any = { headers: { authorization: 'Bearer fixture' } }, context: any = { switchToHttp: () => ({ getRequest: () => req }) };
    const guard = new JwtAuthGuard(jwt, db); expect(await guard.canActivate(context)).toBe(true); expect(req.user.role).toBe('USER');
    db.user.findUnique.mockResolvedValue({ id: 1, role: 'USER', status: 'ACTIVE' }); await expect(guard.canActivate(context)).rejects.toThrow();
    db.user.findUnique.mockResolvedValue({ id: 1, role: 'USER', status: 'ACTIVE', authVersion: 1 }); await expect(guard.canActivate(context)).rejects.toThrow();
  });
  test('controller closes a stale SSE connection without cancelling the task or returning private inputs', async () => {
    const runs: any = { get: jest.fn().mockResolvedValueOnce({ status: 'RUNNING', result: {} }).mockRejectedValueOnce(new Error('version changed')), cancel: jest.fn() };
    const res: any = new EventEmitter(); res.setHeader = jest.fn(); res.flushHeaders = jest.fn(); res.write = jest.fn(() => true);
    res.end = jest.fn(() => { res.writableEnded = true; });
    await new ChatRunController(runs).events({ sub: 11, authVersion: 2 }, 'fixture-id', '0', res);
    expect(runs.get.mock.calls).toEqual([[11, 'fixture-id', 2], [11, 'fixture-id', 2]]); expect(runs.cancel).not.toHaveBeenCalled(); expect(res.end).toHaveBeenCalled();
    expect(res.write.mock.calls[0][0]).toContain('event: terminal'); expect(res.write.mock.calls[0][0]).not.toContain('version changed');
  });
});
