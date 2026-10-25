import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { readSearchHtml } from './web-search.transport';
jest.mock('node:https', () => ({ request: jest.fn() }));
jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
describe('fixed-host search transport', () => {
  const url = new URL('https://www.bing.com/search?q=synthetic');
  let response: any, requestOptions: any, requestUrl: URL;
  beforeEach(() => {
    jest.useRealTimers(); jest.resetAllMocks();
    (lookup as jest.Mock).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    (request as jest.Mock).mockImplementation((address, options, receive) => {
      requestUrl = address; requestOptions = options;
      const req: any = new EventEmitter();
      req.destroy = (error: Error) => { response?.destroy(); if (error) req.emit('error', error); };
      req.end = () => { response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/html' } }); receive(response); };
      options.signal.addEventListener('abort', () => req.destroy(options.signal.reason), { once: true });
      return req;
    });
  });
  afterEach(() => { response?.destroy(); jest.useRealTimers(); });
  test('pins validated DNS on the same HTTPS request and retains original TLS hostname', async () => {
    const operation = readSearchHtml(url); await new Promise(setImmediate);
    expect(requestUrl.hostname).toBe('www.bing.com');
    const one = jest.fn(), all = jest.fn(); requestOptions.lookup('www.bing.com', {}, one); requestOptions.lookup('www.bing.com', { all: true }, all);
    expect(one).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    expect(requestOptions).not.toHaveProperty('rejectUnauthorized', false);
    expect(requestOptions.agent).toBe(false);
    response.end('<html>synthetic</html>'); expect(await operation).toBe('<html>synthetic</html>');
  });
  test('mixed public/private DNS is rejected before opening a socket', async () => {
    (lookup as jest.Mock).mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '198.18.0.1', family: 4 }]);
    await expect(readSearchHtml(url)).rejects.toThrow('Search DNS rejected'); expect(request).not.toHaveBeenCalled();
  });
  test('rejects redirect responses rather than following an attacker-controlled location', async () => {
    (request as jest.Mock).mockImplementation((_address, _options, receive) => {
      const req: any = new EventEmitter(); req.end = () => {
        response = Object.assign(new PassThrough(), { statusCode: 302, headers: { location: 'http://127.0.0.1/private', 'content-type': 'text/html' } }); receive(response);
      }; return req;
    });
    await expect(readSearchHtml(url)).rejects.toThrow('Search engine unavailable'); expect(request).toHaveBeenCalledTimes(1);
  });
  test('bounds body size and honors caller cancellation after headers', async () => {
    const oversized = readSearchHtml(url); const failed = expect(oversized).rejects.toThrow('Search response too large'); await new Promise(setImmediate);
    response.write(Buffer.alloc(2 * 1024 * 1024 + 1)); await failed;
    const controller = new AbortController(), cancelled = readSearchHtml(url, controller.signal);
    const stopped = expect(cancelled).rejects.toThrow('synthetic cancellation'); await new Promise(setImmediate);
    controller.abort(new Error('synthetic cancellation')); await stopped;
  });
  test('eight-second deadline covers a stalled DNS lookup and a stalled body', async () => {
    jest.useFakeTimers(); (lookup as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));
    const dns = expect(readSearchHtml(url)).rejects.toThrow('Search timeout'); await jest.advanceTimersByTimeAsync(8001); await dns;
    const body = expect(readSearchHtml(url)).rejects.toThrow('Search timeout'); await jest.advanceTimersByTimeAsync(1);
    await jest.advanceTimersByTimeAsync(8001); await body;
  });
});
