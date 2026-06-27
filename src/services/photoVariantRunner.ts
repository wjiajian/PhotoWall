import { Worker } from 'worker_threads';
import {
  buildPhotoVariantsFromTemp,
  type BuildPhotoVariantsInput,
  type PhotoVariantBundle,
} from './photoMedia.js';
import type {
  PhotoWorkerRequest,
  PhotoWorkerResponse,
} from './photoImageWorker.js';

/**
 * 照片变体生成调度器。
 *
 * 上传队列严格串行（同一时刻仅一张照片在处理），因此这里维持单个可复用的 worker
 * 即可，无需线程池。worker 懒加载、跨文件复用以摊薄启动成本；超时时 terminate
 * 实现真正的任务中断；每处理 N 张后回收一次，避免原生内存长期累积。
 */

const workerUrl = new URL('./photoImageWorker.js', import.meta.url);

// ts-node 直跑 .ts 源码时（npm run start 开发模式）不存在编译后的 .js worker 文件，
// 退回到主线程内联处理（开发环境可接受短暂阻塞）。也可用 PHOTO_WORKER_DISABLED=1 强制关闭。
const workerDisabled =
  process.env.PHOTO_WORKER_DISABLED === '1' || import.meta.url.endsWith('.ts');

const parsedRecycle = Number.parseInt(process.env.PHOTO_WORKER_RECYCLE_EVERY || '20', 10);
const recycleEvery = Number.isFinite(parsedRecycle) && parsedRecycle > 0 ? parsedRecycle : 20;

const parsedHeapMb = Number.parseInt(process.env.PHOTO_WORKER_MAX_OLD_SPACE_MB || '256', 10);
const workerMaxOldSpaceMb = Number.isFinite(parsedHeapMb) && parsedHeapMb > 0 ? parsedHeapMb : 256;

let worker: Worker | null = null;
let processedSinceSpawn = 0;
let nextRequestId = 1;

function spawnWorker(): Worker {
  // 注意：worker 的 execArgv 不接受 --expose-gc（会抛 ERR_WORKER_INVALID_EXEC_ARGV）。
  // 内存回收依靠「每处理 N 张后 terminate 重建」彻底释放原生内存，无需手动 gc。
  const w = new Worker(workerUrl, {
    resourceLimits: { maxOldGenerationSizeMb: workerMaxOldSpaceMb },
  });
  // 空闲期间的异常/退出只清理模块引用，不抛出（避免无监听者的 'error' 拖垮主进程）。
  // 真正在途的请求由 runPhotoVariant 内的临时监听器负责 reject。
  w.on('error', () => {
    if (worker === w) {
      worker = null;
      processedSinceSpawn = 0;
    }
  });
  w.on('exit', () => {
    if (worker === w) {
      worker = null;
      processedSinceSpawn = 0;
    }
  });
  // 不让空闲 worker 阻止进程优雅退出；处理期间主线程的 HTTP server 已保持事件循环存活。
  w.unref();
  return w;
}

function ensureWorker(): Worker {
  if (!worker) {
    worker = spawnWorker();
    processedSinceSpawn = 0;
  }
  return worker;
}

function destroyWorker(): void {
  if (worker) {
    const w = worker;
    worker = null;
    processedSinceSpawn = 0;
    void w.terminate();
  }
}

function maybeRecycle(): void {
  if (worker && processedSinceSpawn >= recycleEvery) {
    destroyWorker();
  }
}

function runInThread(
  input: BuildPhotoVariantsInput,
  timeoutMs: number,
): Promise<PhotoVariantBundle> {
  const work = buildPhotoVariantsFromTemp(input);
  if (timeoutMs <= 0) return work;
  // 兜底路径无法真正中断原生任务，仅做超时拒绝，行为与旧版 withTimeout 一致。
  work.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`照片处理超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`)),
      timeoutMs,
    );
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 生成照片三种变体。生产环境走 worker 子线程（不阻塞主线程，超时可真正中断），
 * 开发/禁用场景退回主线程内联处理。
 */
export function runPhotoVariant(
  input: BuildPhotoVariantsInput,
  timeoutMs: number,
): Promise<PhotoVariantBundle> {
  if (workerDisabled) {
    return runInThread(input, timeoutMs);
  }

  return new Promise<PhotoVariantBundle>((resolve, reject) => {
    const w = ensureWorker();
    const id = nextRequestId++;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      w.off('message', onMessage);
      w.off('error', onError);
      w.off('exit', onExit);
      if (timer) clearTimeout(timer);
    };

    const onMessage = (msg: PhotoWorkerResponse): void => {
      if (!msg || msg.id !== id || settled) return;
      settled = true;
      cleanup();
      processedSinceSpawn += 1;

      if (msg.ok) {
        resolve({
          width: msg.width,
          height: msg.height,
          photoDate: msg.photoDate,
          full: Buffer.from(msg.full),
          medium: Buffer.from(msg.medium),
          tiny: Buffer.from(msg.tiny),
        });
        maybeRecycle();
      } else {
        reject(new Error(msg.error || '照片处理失败'));
        // 处理出错可能使 worker 处于不确定状态，回收重建更稳妥。
        destroyWorker();
      }
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      destroyWorker();
      reject(err);
    };

    const onExit = (code: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (worker === w) worker = null;
      reject(new Error(`照片处理 worker 异常退出（code ${code}）`));
    };

    w.on('message', onMessage);
    w.on('error', onError);
    w.on('exit', onExit);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        // 真正中断卡死的原生任务：终止 worker，下一张会自动重建。
        destroyWorker();
        reject(new Error(`照片处理超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
    }

    const request: PhotoWorkerRequest = {
      type: 'process',
      id,
      tempPath: input.tempPath,
      extension: input.extension,
      inputSizeBytes: input.inputSizeBytes,
      fallbackIsoDate: input.fallbackIsoDate,
    };
    w.postMessage(request);
  });
}

/** 优雅关闭：进程退出前终止常驻 worker。 */
export async function shutdownPhotoVariantWorker(): Promise<void> {
  if (worker) {
    const w = worker;
    worker = null;
    processedSinceSpawn = 0;
    await w.terminate();
  }
}
