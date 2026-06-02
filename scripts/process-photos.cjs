const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const convert = require('heic-convert');
const exifr = require('exifr');
const { PHOTO_EXTENSION_REGEX } = require('../shared/photo-extensions.cjs');

// Legacy/manual backfill tool: the primary production workflow now updates
// OSS objects and src/data/images-metadata.json through src/routes/photos.ts.

const ROOT = path.join(__dirname, '../public/photowall');
const ORIGIN_DIR = path.join(ROOT, 'origin');
const THUMBNAILS_DIR = path.join(ROOT, 'thumbnails');
const FULL_DIR = path.join(THUMBNAILS_DIR, 'full');
const MEDIUM_DIR = path.join(THUMBNAILS_DIR, 'medium');
const TINY_DIR = path.join(THUMBNAILS_DIR, 'tiny');
const OUTPUT_FILE = path.join(__dirname, '../src/data/images-metadata.json');
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.PHOTOWALL_PROCESS_CONCURRENCY) || 2));

// 确保目录存在
[FULL_DIR, MEDIUM_DIR, TINY_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const EXTENSIONS = PHOTO_EXTENSION_REGEX;

function formatDate(date) {
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    const pad = (n) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getFormatLabelFromExtension(extension) {
    const normalized = extension.toLowerCase();
    if (normalized === '.jpg' || normalized === '.jpeg') return 'JPEG';
    if (normalized === '.heic') return 'HEIC';
    if (normalized === '.heif') return 'HEIF';
    return normalized.replace('.', '').toUpperCase();
}

function warnWithContext(message, error) {
    if (error) {
        console.warn(message, error instanceof Error ? error.message : error);
        return;
    }
    console.warn(message);
}

async function resolveDimensions(inputBuffer, contextLabel) {
    try {
        const metadata = await sharp(inputBuffer).metadata();
        return {
            width: Number.isFinite(metadata.width) ? metadata.width : 0,
            height: Number.isFinite(metadata.height) ? metadata.height : 0
        };
    } catch (error) {
        warnWithContext(`  Warning: failed to resolve dimensions for ${contextLabel}, fallback to 0x0.`, error);
        return { width: 0, height: 0 };
    }
}

async function runWithConcurrency(items, concurrency, worker) {
    if (!items.length) return [];

    const results = new Array(items.length);
    let currentIndex = 0;

    async function consume() {
        while (true) {
            const index = currentIndex;
            currentIndex += 1;
            if (index >= items.length) break;
            results[index] = await worker(items[index], index);
        }
    }

    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: workerCount }, () => consume()));
    return results;
}

async function processSinglePhoto(baseName, locations, existingMap) {
    let sourcePath = '';
    let file = '';
    let isOrigin = false;

    if (locations.origin) {
        sourcePath = path.join(ORIGIN_DIR, locations.origin);
        file = locations.origin;
        isOrigin = true;
    } else if (locations.full) {
        sourcePath = path.join(FULL_DIR, locations.full);
        file = locations.full;
        isOrigin = false;
    } else {
        return null;
    }

    const stats = fs.statSync(sourcePath);
    const ext = path.extname(file).toLowerCase();

    console.log(`Processing: ${baseName} (${ext})`);

    let date = null;
    let finalFormat = getFormatLabelFromExtension(ext);

    const isHeic = ext === '.heic' || ext === '.heif';
    const outputFullPath = path.join(FULL_DIR, `${baseName}.jpg`);
    let fullSrcPath = '';
    let mediumPathDisplay = `/photowall/thumbnails/medium/${baseName}.jpg`;
    let tinyPathDisplay = `/photowall/thumbnails/tiny/${baseName}.jpg`;
    let originalPathDisplay = isOrigin
        ? `/photowall/origin/${locations.origin}`
        : '';

    let inputBuffer = fs.readFileSync(sourcePath);

    // 使用 exifr 提取日期
    try {
        const meta = await exifr.parse(inputBuffer);
        if (meta && (meta.DateTimeOriginal || meta.CreateDate || meta.ModifyDate)) {
            date = formatDate(meta.DateTimeOriginal || meta.CreateDate || meta.ModifyDate);
        }
    } catch (err) {}

    // 日期兜底
    if (!date && existingMap.has(locations.origin || locations.full)) {
        date = existingMap.get(locations.origin || locations.full).date;
    }
    if (!date) {
        date = formatDate(stats.mtime);
    }

    // 统一生成 full JPEG，确保前端展示路径稳定
    const shouldRegenerateFull =
        !fs.existsSync(outputFullPath) ||
        (sourcePath !== outputFullPath && fs.statSync(outputFullPath).mtimeMs < stats.mtimeMs);

    if (shouldRegenerateFull) {
        if (isHeic) {
            console.log('  Converting HEIC/HEIF to JPEG...');
            const jpegBuffer = await convert({
                buffer: inputBuffer,
                format: 'JPEG',
                quality: 0.9
            });
            fs.writeFileSync(outputFullPath, jpegBuffer);
        } else if (ext === '.jpg' || ext === '.jpeg') {
            if (sourcePath !== outputFullPath) {
                fs.copyFileSync(sourcePath, outputFullPath);
            }
        } else {
            // PNG/WebP 等格式统一转为 JPEG，避免展示链路分叉
            await sharp(inputBuffer)
                .jpeg({ quality: 92, mozjpeg: true })
                .toFile(outputFullPath);
        }
    }

    if (!fs.existsSync(outputFullPath)) {
        throw new Error(`Missing full image after processing: ${outputFullPath}`);
    }

    inputBuffer = fs.readFileSync(outputFullPath);
    fullSrcPath = `/photowall/thumbnails/full/${baseName}.jpg`;

    // 生成缩略图
    const mediumFsPath = path.join(MEDIUM_DIR, `${baseName}.jpg`);
    const tinyFsPath = path.join(TINY_DIR, `${baseName}.jpg`);
    const fullStats = fs.statSync(outputFullPath);
    const { width, height } = await resolveDimensions(inputBuffer, baseName);

    if (!fs.existsSync(mediumFsPath) || fs.statSync(mediumFsPath).mtimeMs < fullStats.mtimeMs) {
        await sharp(inputBuffer)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80, mozjpeg: true })
            .toFile(mediumFsPath);
    }

    if (!fs.existsSync(tinyFsPath) || fs.statSync(tinyFsPath).mtimeMs < fullStats.mtimeMs) {
        await sharp(inputBuffer)
            .resize(50, 50, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 60 })
            .toFile(tinyFsPath);
    }

    let videoSrc = undefined;
    const key = locations.origin || locations.full;
    if (existingMap.has(key)) {
        videoSrc = existingMap.get(key).videoSrc;
    }

    return {
        filename: key,
        originalSrc: originalPathDisplay || fullSrcPath,
        src: fullSrcPath,
        srcMedium: mediumPathDisplay,
        srcTiny: tinyPathDisplay,
        width,
        height,
        size: stats.size,
        format: finalFormat,
        date,
        videoSrc
    };
}

async function processPhotos() {
    console.log('Starting photo processing...');

    // 读取已有元数据，必要时保留信息/日期
    let existingMetadata = [];
    if (fs.existsSync(OUTPUT_FILE)) {
        try {
            existingMetadata = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
        } catch(e) {}
    }
    const existingMap = new Map(existingMetadata.map(item => [item.filename, item]));

    // 2. 同时扫描 origin 与 full 目录（包含已转换文件）
    // 优先使用 origin 文件；若仅存在于 full，视为已转换文件保留
    const originFiles = fs.existsSync(ORIGIN_DIR) ? fs.readdirSync(ORIGIN_DIR).filter(file => EXTENSIONS.test(file)) : [];
    const fullFiles = fs.existsSync(FULL_DIR) ? fs.readdirSync(FULL_DIR).filter(file => EXTENSIONS.test(file)) : [];

    // 创建 baseName -> { origin, full } 的映射
    const fileMap = new Map();

    originFiles.forEach(file => {
        const ext = path.extname(file).toLowerCase();
        const base = path.basename(file, ext);
        if (!fileMap.has(base)) fileMap.set(base, {});
        fileMap.get(base).origin = file;
    });

    fullFiles.forEach(file => {
        const ext = path.extname(file).toLowerCase();
        const base = path.basename(file, ext);
        if (!fileMap.has(base)) fileMap.set(base, {});
        fileMap.get(base).full = file;
    });

    console.log(`Found ${fileMap.size} unique images.`);

    if (fileMap.size === 0) {
        console.log(`No photos found under photowall (bucket/prefix context: local:${ORIGIN_DIR} | local:${FULL_DIR}).`);
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify([], null, 2));
        console.log(`Metadata saved to ${OUTPUT_FILE}`);
        return;
    }

    const entries = Array.from(fileMap.entries());
    const results = await runWithConcurrency(entries, DEFAULT_CONCURRENCY, async ([baseName, locations]) => {
        try {
            return await processSinglePhoto(baseName, locations, existingMap);
        } catch (err) {
            warnWithContext(`  Warning: skip ${baseName}, failed to rebuild metadata entry.`, err);
            return null;
        }
    });

    const newMetadata = results.filter(Boolean);

    // 按日期降序排序
    newMetadata.sort((a, b) => {
        if (a.date && b.date) {
            return b.date.localeCompare(a.date);
        }
        return a.filename.localeCompare(b.filename);
    });

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(newMetadata, null, 2));
    console.log(`Done! Processed ${newMetadata.length} images.`);
    console.log(`Metadata saved to ${OUTPUT_FILE}`);
}

processPhotos().catch(error => {
    console.error('Photo processing failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
