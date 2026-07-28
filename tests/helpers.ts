import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { PhotoOssClient } from '../src/services/photoMedia.js';

export async function createTestDirectory(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function createJpegHeader(width: number, height: number): Buffer {
  const app0Payload = new Array<number>(14).fill(0);
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, ...app0Payload,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

interface FakeObject {
  body: Buffer;
  headers: Record<string, string>;
}

export class FakePhotoOss {
  readonly objects = new Map<string, FakeObject>();
  readonly processCalls: Array<{ source: string; target: string; process: string }> = [];
  readonly copyCalls: Array<{ target: string; source: string; headers: Record<string, string> }> = [];
  readonly deleteCalls: string[] = [];
  failProcessAttempts = 0;
  alwaysFailTarget: string | null = null;
  processGate: Promise<void> | null = null;

  client(): PhotoOssClient {
    return {
      put: async (key: string, body: AsyncIterable<Uint8Array> | Buffer, options?: { headers?: Record<string, string> }) => {
        const chunks: Buffer[] = [];
        if (Buffer.isBuffer(body)) {
          chunks.push(body);
        } else {
          for await (const chunk of body) chunks.push(Buffer.from(chunk));
        }
        this.objects.set(key, {
          body: Buffer.concat(chunks),
          headers: { ...(options?.headers ?? {}) },
        });
        return { name: key, url: key, data: {}, res: { status: 200 } };
      },
      head: async (key: string) => {
        const object = this.objects.get(key);
        if (!object) throw Object.assign(new Error('NoSuchKey'), { status: 404, code: 'NoSuchKey' });
        return { status: 200, meta: {}, res: { status: 200, headers: object.headers } };
      },
      processObjectSave: async (source: string, target: string, process: string) => {
        this.processCalls.push({ source, target, process });
        if (this.processGate) await this.processGate;
        if (this.failProcessAttempts > 0) {
          this.failProcessAttempts -= 1;
          throw Object.assign(new Error('temporary OSS timeout'), { code: 'ConnectionTimeoutError' });
        }
        if (this.alwaysFailTarget === target) throw new Error('persistent OSS processing failure');
        const sourceObject = this.objects.get(source);
        if (!sourceObject) throw Object.assign(new Error('NoSuchKey'), { status: 404, code: 'NoSuchKey' });
        this.objects.set(target, { body: sourceObject.body, headers: {} });
        return { status: 200, res: { status: 200 } };
      },
      copy: async (target: string, source: string, options?: { headers?: Record<string, string> }) => {
        const sourceObject = this.objects.get(source);
        if (!sourceObject) throw Object.assign(new Error('NoSuchKey'), { status: 404, code: 'NoSuchKey' });
        const headers = { ...(options?.headers ?? {}) };
        this.copyCalls.push({ target, source, headers });
        this.objects.set(target, { body: sourceObject.body, headers });
        return { data: {}, res: { status: 200 } };
      },
      delete: async (key: string) => {
        this.deleteCalls.push(key);
        this.objects.delete(key);
        return { res: { status: 204 } };
      },
      get: async () => {
        return {
          content: Buffer.from(JSON.stringify({
            DateTimeOriginal: { value: '2026:07:28 10:30:00' },
          })),
          res: { status: 200 },
        };
      },
    } as unknown as PhotoOssClient;
  }
}
