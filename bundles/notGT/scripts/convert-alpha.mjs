#!/usr/bin/env node
/**
 * convert-alpha — turns a heavy alpha video (.mov / ProRes 4444 / HEVC+alpha)
 * into something an OBS Browser Source can actually play.
 *
 * Why this exists: Chromium (and therefore the OBS Browser Source) cannot
 * decode ProRes at all and has no alpha in H.264, so such a file will never
 * play no matter how small it is. The two formats that do work with alpha are
 * animated WebP (as an <img>, i.e. a `gif` layer or a code animation) and
 * WebM VP8/VP9 (as a <video>, i.e. a `video` layer).
 *
 * The script probes the input, detects the real content box, downscales if
 * asked, picks a sensible target format and prints the served URL to paste
 * into a layer.
 *
 *   node scripts/convert-alpha.mjs overlay.mov
 *   node scripts/convert-alpha.mjs overlay.mov --max-width 960 --format webm
 *   node scripts/convert-alpha.mjs overlay.mov --dry-run
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundleDir = path.resolve(here, "..");
const DEFAULT_OUT_DIR = path.join(bundleDir, "graphics", "media");
const URL_PREFIX = "/bundles/notGT/graphics/media/";

const ALPHA_PIX_FMT = /(yuva|ya[0-9]|rgba|bgra|argb|abgr|gbrap|pal8)/i;
const FORMATS = {
	webp: {
		ext: "webp",
		label: "animated WebP (alpha)",
		note: "ставится как слой gif/image или как <img> в code-анимации",
	},
	webm: {
		ext: "webm",
		label: "WebM VP9 (alpha)",
		note: "ставится как слой video или как <video> в code-анимации",
	},
	"webm-vp8": {
		ext: "webm",
		label: "WebM VP8 (alpha)",
		note: "легче декодируется, файл крупнее; тоже слой video",
	},
};

function usage() {
	console.log(`
convert-alpha — конвертация alpha-видео для OBS Browser Source

  node scripts/convert-alpha.mjs <input.mov> [options]

Опции:
  -o, --out <dir>       каталог результата (по умолчанию graphics/media)
  -f, --format <fmt>    auto | webp | webm | webm-vp8   (по умолчанию auto)
  -q, --quality <0-100> качество WebP                        (по умолчанию 80)
      --crf <n>         CRF для VP8/VP9                       (по умолчанию 30)
      --bitrate <rate>  битрейт для VP8                       (по умолчанию 3M)
      --fps <n>         пересчитать частоту кадров
      --scale <w:h>     явный масштаб, напр. 960:540
      --max-width <px>  уменьшить, только если шире (пропорции сохраняются)
      --threshold <sec> с какого времени auto выбирает webm     (по умолчанию 10)
      --crop <w:h:x:y>  явная обрезка
      --no-crop         не искать содержимое автоматически
      --dry-run         только показать команды
  -h, --help            эта справка

Почему .mov не играет в браузере:
  Chromium не декодирует ProRes и не поддерживает alpha в H.264, поэтому
  ProRes 4444 / HEVC+alpha / Animation .mov в Browser Source не запустятся
  вообще — независимо от размера файла.
`);
}

function parseArgs(argv) {
	const opts = {
		input: undefined,
		outDir: DEFAULT_OUT_DIR,
		format: "auto",
		quality: 80,
		crf: 30,
		bitrate: "3M",
		fps: undefined,
		scale: undefined,
		maxWidth: undefined,
		threshold: 10,
		crop: undefined,
		noCrop: false,
		dryRun: false,
	};
	const need = (i, name) => {
		if (i + 1 >= argv.length) fail(`Опция ${name} требует значение`);
		return argv[i + 1];
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "-h":
			case "--help":
				usage();
				process.exit(0);
			case "-o":
			case "--out":
				opts.outDir = path.resolve(need(i, a));
				i++;
				break;
			case "-f":
			case "--format":
				opts.format = need(i, a);
				i++;
				break;
			case "-q":
			case "--quality":
				opts.quality = Number(need(i, a));
				i++;
				break;
			case "--crf":
				opts.crf = Number(need(i, a));
				i++;
				break;
			case "--bitrate":
				opts.bitrate = need(i, a);
				i++;
				break;
			case "--fps":
				opts.fps = Number(need(i, a));
				i++;
				break;
			case "--scale":
				opts.scale = need(i, a);
				i++;
				break;
			case "--max-width":
				opts.maxWidth = Number(need(i, a));
				i++;
				break;
			case "--threshold":
				opts.threshold = Number(need(i, a));
				i++;
				break;
			case "--crop":
				opts.crop = need(i, a);
				i++;
				break;
			case "--no-crop":
				opts.noCrop = true;
				break;
			case "--dry-run":
				opts.dryRun = true;
				break;
			default:
				if (a.startsWith("-")) fail(`Неизвестная опция: ${a}`);
				else if (!opts.input) opts.input = path.resolve(a);
				else fail(`Лишний аргумент: ${a}`);
		}
	}
	if (!opts.input) {
		usage();
		fail("Не указан входной файл");
	}
	if (!["auto", ...Object.keys(FORMATS)].includes(opts.format)) {
		fail(`--format должен быть одним из: auto, ${Object.keys(FORMATS).join(", ")}`);
	}
	return opts;
}

function fail(message) {
	console.error(`\n  ✖ ${message}\n`);
	process.exit(1);
}

function which(bin) {
	const res = spawnSync(bin, ["-version"], { encoding: "utf8" });
	if (res.error) fail(`${bin} не найден. Установите ffmpeg (в нём же есть ffprobe).`);
}

function ffprobe(input) {
	which("ffprobe");
	const res = spawnSync(
		"ffprobe",
		[
			"-v", "error",
			"-select_streams", "v:0",
			"-show_entries",
			"stream=codec_name,pix_fmt,width,height,r_frame_rate,duration,nb_frames,bit_rate",
			"-show_entries", "format=duration,size",
			"-of", "json",
			input,
		],
		{ encoding: "utf8" },
	);
	if (res.status !== 0) fail(`ffprobe не смог прочитать файл:\n${res.stderr ?? ""}`);
	const data = JSON.parse(res.stdout);
	const stream = data.streams?.[0];
	if (!stream) fail("В файле нет видеодорожки");
	const [num, den] = String(stream.r_frame_rate ?? "0/1").split("/").map(Number);
	return {
		codec: stream.codec_name,
		pixFmt: stream.pix_fmt,
		width: stream.width,
		height: stream.height,
		fps: den ? num / den : 0,
		duration: Number(stream.duration ?? data.format?.duration ?? 0),
		size: Number(data.format?.size ?? 0),
	};
}

/** Runs cropdetect over the first few seconds and returns `w:h:x:y` or undefined. */
function detectCrop(input, duration) {
	const seconds = Math.min(Math.max(duration || 3, 0.5), 3);
	const res = spawnSync(
		"ffmpeg",
		[
			"-hide_banner", "-nostats",
			"-t", String(seconds),
			"-i", input,
			"-vf", "cropdetect=limit=0.1:round=2:reset=0",
			"-f", "null", "-",
		],
		{ encoding: "utf8" },
	);
	const text = `${res.stderr ?? ""}`;
	const matches = [...text.matchAll(/crop=([0-9]+:[0-9]+:[0-9]+:[0-9]+)/g)];
	return matches.length ? matches[matches.length - 1][1] : undefined;
}

function humanSize(bytes) {
	if (!bytes) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function buildFilters(opts, crop) {
	const filters = [];
	if (crop) filters.push(`crop=${crop}`);
	if (opts.fps) filters.push(`fps=${opts.fps}`);
	if (opts.scale) filters.push(`scale=${opts.scale}`);
	else if (opts.maxWidth) filters.push(`scale='min(${opts.maxWidth},iw)':-2`);
	return filters;
}

function buildArgs(opts, format, filters, output) {
	const args = ["-hide_banner", "-loglevel", "warning", "-y", "-i", opts.input];
	if (filters.length) args.push("-vf", filters.join(","));
	if (format === "webp") {
		args.push(
			"-c:v", "libwebp_anim",
			"-pix_fmt", "yuva420p",
			"-q:v", String(opts.quality),
			"-loop", "0",
			"-an",
		);
	} else if (format === "webm") {
		args.push(
			"-c:v", "libvpx-vp9",
			"-pix_fmt", "yuva420p",
			// Without this libvpx refuses to encode transparency at all.
			"-auto-alt-ref", "0",
			"-b:v", "0",
			"-crf", String(opts.crf),
			"-row-mt", "1",
			"-cpu-used", "4",
			"-an",
		);
	} else {
		args.push(
			"-c:v", "libvpx",
			"-pix_fmt", "yuva420p",
			"-auto-alt-ref", "0",
			"-b:v", opts.bitrate,
			"-an",
		);
	}
	args.push(output);
	return args;
}

/**
 * ffmpeg's decoder does not expose the alpha plane of WebM, so a decode-based
 * check there is meaningless (it reports the clip as opaque even when Chromium
 * plays it correctly). We only verify WebP, and say so for WebM.
 */
function verifyAlpha(file, format) {
	if (format !== "webp") return "unknown";
	const res = spawnSync(
		"ffmpeg",
		["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "-"],
		{ maxBuffer: 1 << 28 },
	);
	if (res.status !== 0 || !res.stdout?.length) return "unknown";
	const data = res.stdout;
	let min = 255;
	let max = 0;
	for (let i = 3; i < data.length; i += 4) {
		const a = data[i];
		if (a < min) min = a;
		if (a > max) max = a;
	}
	return min === 0 && max === 255 ? "yes" : "no";
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	which("ffmpeg");

	if (!fs.existsSync(opts.input)) fail(`Файл не найден: ${opts.input}`);

	const info = ffprobe(opts.input);
	const hasAlpha = ALPHA_PIX_FMT.test(info.pixFmt ?? "");

	console.log(`\n  Вход:  ${path.basename(opts.input)}`);
	console.log(
		`         ${info.codec} ${info.pixFmt} ${info.width}x${info.height} ` +
			`${info.fps ? `${info.fps.toFixed(2)} fps` : ""} ` +
			`${info.duration ? `${info.duration.toFixed(2)} c` : ""} ` +
			`${humanSize(info.size)}`,
	);

	if (!hasAlpha) {
		console.log(
			"\n  ⚠ В источнике нет alpha-канала — прозрачности в результате не будет.\n" +
				"    Если она ожидалась, проверьте экспорт (нужен ProRes 4444 / HEVC+alpha / yuva).",
		);
	} else if (!/^(yuva|rgba|bgra|argb|abgr)/i.test(info.pixFmt ?? "")) {
		console.log(`\n  ⚠ alpha есть, но формат ${info.pixFmt} — конвертация всё равно возможна.`);
	}

	// ---- choose the target format -------------------------------------
	let format = opts.format;
	if (format === "auto") {
		format = info.duration > 0 && info.duration <= opts.threshold ? "webp" : "webm";
		console.log(
			`\n  Формат: auto → ${FORMATS[format].label} ` +
				`(${info.duration.toFixed(1)} c ${info.duration <= opts.threshold ? "≤" : ">"} ${opts.threshold} c)`,
		);
	} else {
		console.log(`\n  Формат: ${FORMATS[format].label}`);
	}

	// ---- crop / scale --------------------------------------------------
	let crop;
	if (opts.crop) {
		crop = opts.crop;
		console.log(`  Обрезка: задана вручную — ${crop}`);
	} else if (!opts.noCrop) {
		crop = detectCrop(opts.input, info.duration);
		if (crop) {
			const [w, h] = crop.split(":").map(Number);
			const share = ((w * h) / (info.width * info.height)) * 100;
			console.log(
				`  Обрезка: ${crop} — ${w}x${h}, это ${share.toFixed(0)}% площади кадра` +
					(share < 70 ? " (крупный выигрыш)" : ""),
			);
			const fullFrame = w >= info.width && h >= info.height;
			if (w <= 2 || h <= 2) {
				console.log("  ⚠ cropdetect вернул почти пустой бокс — обрезка отключена");
				crop = undefined;
			} else if (fullFrame) {
				console.log("  Обрезка: содержимое занимает весь кадр — фильтр не нужен");
				crop = undefined;
			}
		} else {
			console.log("  Обрезка: содержимое не определено, оставляю как есть");
		}
	}

	const filters = buildFilters(opts, crop);
	if (filters.length) console.log(`  Фильтры: ${filters.join(", ")}`);

	// ---- run -----------------------------------------------------------
	fs.mkdirSync(opts.outDir, { recursive: true });
	const base = path.basename(opts.input, path.extname(opts.input));
	const output = path.join(opts.outDir, `${base}.${FORMATS[format].ext}`);
	const args = buildArgs(opts, format, filters, output);

	if (opts.dryRun) {
		console.log(`\n  [dry-run] ffmpeg ${args.join(" ")}\n`);
		return;
	}

	console.log(`\n  Кодирую → ${path.relative(process.cwd(), output)} ...`);
	const started = Date.now();
	const run = spawnSync("ffmpeg", args, { stdio: "inherit" });
	const elapsed = ((Date.now() - started) / 1000).toFixed(1);
	if (run.status !== 0 || !fs.existsSync(output)) {
		fail(`ffmpeg завершился с ошибкой (код ${run.status}). Смотрите вывод выше.`);
	}

	// ---- report --------------------------------------------------------
	const outSize = fs.statSync(output).size;
	const ratio = info.size ? outSize / info.size : 0;
	console.log(`\n  Готово за ${elapsed} c`);
	console.log(
		`  Размер:  ${humanSize(info.size)} → ${humanSize(outSize)}` +
			(ratio ? `  (×${ratio.toFixed(ratio < 0.1 ? 3 : 1)})` : ""),
	);

	const alpha = verifyAlpha(output, format);
	if (alpha === "yes") console.log("  Alpha:   проверено — прозрачность на месте ✔");
	else if (alpha === "no") console.log("  Alpha:   ⚠ прозрачность не обнаружена, проверьте исходник");
	else {
		console.log(
			"  Alpha:   у WebM ffmpeg не показывает alpha-план (это нормально — он лежит\n" +
				"           отдельным auxiliary-планом). Проверяйте в OBS или Chromium, не в ffprobe.",
		);
	}
	if (outSize > info.size) {
		console.log("  ⚠ Результат больше исходника — попробуйте --crf больше, --max-width меньше");
		console.log("    --threshold меньше (чтобы выбрался webp).");
	}

	const rel = path.relative(opts.outDir, output);
	console.log(`\n  Слой:  src = "${URL_PREFIX}${rel}"`);
	console.log(`  Тип:   ${format === "webp" ? "gif / image (или <img> в code)" : "video (или <video> в code)"}`);
	console.log(`  ${FORMATS[format].note}\n`);
}

main();
