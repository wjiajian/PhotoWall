import { parentPort } from 'worker_threads';
import { buildPhotoVariantsFromTemp } from './photoMedia.js';

/**
 * 照片变体生成 worker。
 *
 * 把 heic-convert（纯 JS/WASM、同步阻塞事件循环）与 sharp（CPU 密集）的重活
 * 从主线程剥离到子线程，使 HTTP 主线程在处理大图期间仍可响应请求。配合主线程
 * 的 worker.terminate() 还能真正中断卡死的原生任务（withTimeout 做不到这一点）。
 */

export interface PhotoWorkerRequest {
  type: 'process';
  id: number;
  tempPath: string;
  extension: string;
  inputSizeBytes?: number;
  fallbackIsoDate?: string;
}

export interface PhotoWorkerSuccess {
  id: number;
  ok: true;
  width: number;
  height: number;
  photoDate: string | null;
  full: ArrayBuffer;
  medium: ArrayBuffer;
  tiny: ArrayBuffer;
}

export interface PhotoWorkerFailure {
  id: number;
  ok: false;
  error: string;
}

export type PhotoWorkerResponse = PhotoWorkerSuccess | PhotoWorkerFailure;

if (!parentPort) {
  throw new Error('photoImageWorker 必须以 worker 线程方式运行');
}

const port = parentPort;

// 把可能指向共享内存池的 Buffer 切出独立 ArrayBuffer，确保可安全 transfer。
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

port.on('message', async (msg: PhotoWorkerRequest) => {
  if (!msg || msg.type !== 'process') return;

  try {
    const bundle = await buildPhotoVariantsFromTemp({
      tempPath: msg.tempPath,
      extension: msg.extension,
      inputSizeBytes: msg.inputSizeBytes,
      fallbackIsoDate: msg.fallbackIsoDate,
    });

    const full = toArrayBuffer(bundle.full);
    const medium = toArrayBuffer(bundle.medium);
    const tiny = toArrayBuffer(bundle.tiny);

    const response: PhotoWorkerSuccess = {
      id: msg.id,
      ok: true,
      width: bundle.width,
      height: bundle.height,
      photoDate: bundle.photoDate,
      full,
      medium,
      tiny,
    };

    port.postMessage(response, [full, medium, tiny]);
  } catch (error) {
    const response: PhotoWorkerFailure = {
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(response);
  }
});
