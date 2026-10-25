import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { PositiveIntIdPipe } from '../../common/positive-int-id.pipe';
import { ForumController } from './forum.controller';

const methods = ['toggleWatch', 'removeWatch', 'getPost', 'recordView', 'updatePost', 'deletePost',
  'likePost', 'unlikePost', 'favoritePost', 'unfavoritePost', 'getComments', 'createComment',
  'likeComment', 'deleteComment', 'unlikeComment', 'markNotificationRead'] as const;
const invalidIds = ['12junk', '12.5', 'NaN', 'Infinity', '-1', '0', '+12', '1e2', '0x12', ' 12', '12 ', '',
  '2147483648', '9007199254740993', '9999999999999999999999999999999999999999999'];

describe('strict forum route identifier contract', () => {
  const global = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });

  function parameter(method: typeof methods[number]) {
    const args = Object.values(Reflect.getMetadata(ROUTE_ARGS_METADATA, ForumController, method) || {}) as
      Array<{ index: number; data: string; pipes: unknown[] }>;
    const id = args.find(arg => arg.data === 'id');
    expect(id).toBeDefined();
    expect(id!.pipes).toContain(PositiveIntIdPipe);
    const types = Reflect.getMetadata('design:paramtypes', ForumController.prototype, method);
    // Number metadata would let the global pipe silently turn “1e2” into 100 first.
    expect(types[id!.index]).toBe(String);
    return { metadata: { type: 'param', data: 'id', metatype: types[id!.index] } as ArgumentMetadata };
  }

  async function validated(method: typeof methods[number], wireValue: string) {
    const { metadata } = parameter(method);
    const raw = await global.transform(wireValue, metadata);
    return new PositiveIntIdPipe().transform(raw);
  }

  test.each(methods)('%s rejects malformed or out-of-range IDs before the business service', async method => {
    for (const value of invalidIds) await expect(validated(method, value)).rejects.toBeInstanceOf(BadRequestException);
  });

  test.each(['1', '12', '00012', '2147483647'])('accepts valid decimal ID %s without changing its numeric identity', async value => {
    expect(Number(await validated('getPost', value))).toBe(Number(value));
  });

  test('a valid post request still supplies its numeric ID and viewer identity to the service', async () => {
    const forum = { getPost: jest.fn().mockResolvedValue({ id: 12, title: 'fixture' }) };
    const controller = new ForumController(forum as any, {} as any);
    const result = await controller.getPost(await validated('getPost', '12'), { sub: 41 });
    expect(forum.getPost).toHaveBeenCalledWith(12, 41);
    expect(result).toMatchObject({ success: true, data: { id: 12 } });
  });

  test('valid mutation and subscription requests retain authenticated ownership and body data', async () => {
    const forum = { updatePost: jest.fn().mockResolvedValue({ id: 12 }), deleteComment: jest.fn().mockResolvedValue({ deleted: true }) };
    const subscriptions = { setEnabled: jest.fn().mockResolvedValue({ enabled: false }) };
    const controller = new ForumController(forum as any, subscriptions as any);
    const update = { title: 'fixture edit', expectedRevision: 3 };
    await controller.updatePost(await validated('updatePost', '12'), { sub: 41 }, update);
    await controller.deleteComment(await validated('deleteComment', '12'), { sub: 41 });
    await controller.toggleWatch({ sub: 41 }, await validated('toggleWatch', '12'), { enabled: false });
    expect(forum.updatePost).toHaveBeenCalledWith(12, 41, update);
    expect(forum.deleteComment).toHaveBeenCalledWith(12, 41);
    expect(subscriptions.setEnabled).toHaveBeenCalledWith(41, 12, false);
  });

  test('the pipe fails closed for unexpected values rather than coercing them to a real resource', () => {
    for (const value of [null, undefined, 12, {}, [], ['12']]) {
      expect(() => new PositiveIntIdPipe().transform(value as any)).toThrow(BadRequestException);
    }
  });
});
