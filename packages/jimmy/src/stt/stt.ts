import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { STT_MODELS_DIR, TMP_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

const execFileAsync = promisify(execFile);

const WHISPER_CLI = "whisper-cli";
const FFMPEG = "ffmpeg";

const MODEL_URLS: Record<string, string> = {
  tiny: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  "tiny.en": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
  base: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  "base.en": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
  small: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  "small.en": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
  medium: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
  "medium.en": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin",
  "large-v3-turbo": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
};

const MODEL_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(MODEL_URLS).map(([k, url]) => [k, path.basename(url)]),
);

const EXPECTED_SIZES: Record<string, number> = {
  tiny: 75_000_000,
  "tiny.en": 75_000_000,
  base: 142_000_000,
  "base.en": 142_000_000,
  small: 466_000_000,
  "small.en": 466_000_000,
  medium: 1_500_000_000,
  "medium.en": 1_500_000_000,
  "large-v3-turbo": 1_500_000_000,
};

let downloading = false;
let downloadProgress = 0;

/** Ensure models directory exists. */
export function initStt(): void {
  fs.mkdirSync(STT_MODELS_DIR, { recursive: true });
  logger.info(`STT initialized, models dir: ${STT_MODELS_DIR}`);
}

export function getModelPath(model: string): string | null {
  const filename = MODEL_FILES[model];
  if (!filename) return null;
  const filePath = path.join(STT_MODELS_DIR, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

export interface SttStatus {
  available: boolean;
  model: string | null;
  downloading: boolean;
  progress: number;
  languages: string[];
}

/**
 * Resolve the languages list from config, with backwards compat for the
 * old `language: "en"` string format.
 */
export function resolveLanguages(sttConfig?: { language?: string; languages?: string[] }): string[] {
  if (sttConfig?.languages && sttConfig.languages.length > 0) return sttConfig.languages;
  if (sttConfig?.language) return [sttConfig.language];
  return ["en"];
}

export function getSttStatus(configModel?: string, languages?: string[]): SttStatus {
  const model = configModel || "small";
  const modelPath = getModelPath(model);
  return {
    available: modelPath !== null,
    model: modelPath ? model : null,
    downloading,
    progress: downloadProgress,
    languages: languages || ["en"],
  };
}

export async function downloadModel(
  model: string,
  onProgress: (progress: number) => void,
): Promise<void> {
  if (downloading) throw new Error("Download already in progress");

  const url = MODEL_URLS[model];
  if (!url) throw new Error(`Unknown model: ${model}`);

  if (getModelPath(model)) {
    onProgress(100);
    return;
  }

  downloading = true;
  downloadProgress = 0;

  const filename = MODEL_FILES[model]!;
  const destPath = path.join(STT_MODELS_DIR, filename);
  const tmpPath = destPath + ".downloading";
  const expectedSize = EXPECTED_SIZES[model] || 466_000_000;

  try {
    fs.mkdirSync(STT_MODELS_DIR, { recursive: true });

    await new Promise<void>((resolve, reject) => {
      // Use curl for download — handles redirects, progress, and is reliable
      const curl = spawn("curl", [
        "-L", // follow redirects
        "-o", tmpPath,
        url,
      ]);

      // Poll file size for progress
      const progressInterval = setInterval(() => {
        try {
          const stat = fs.statSync(tmpPath, { throwIfNoEntry: false } as fs.StatSyncOptions & { throwIfNoEntry: false });
          if (stat && stat.size > 0) {
            downloadProgress = Math.min(95, Math.round(((stat.size as number) / expectedSize) * 100));
            onProgress(downloadProgress);
          }
        } catch { /* file not created yet */ }
      }, 1000);

      curl.on("close", (code) => {
        clearInterval(progressInterval);
        if (code === 0) resolve();
        else reject(new Error(`curl exited with code ${code}`));
      });

      curl.on("error", (err) => {
        clearInterval(progressInterval);
        reject(err);
      });
    });

    // Rename temp file to final path
    fs.renameSync(tmpPath, destPath);

    downloadProgress = 100;
    onProgress(100);
    logger.info(`STT model '${model}' downloaded to ${destPath}`);
  } catch (err) {
    // Clean up partial download
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  } finally {
    downloading = false;
  }
}

/**
 * Convert audio to WAV (16kHz mono PCM) using ffmpeg.
 * whisper-cli requires this format.
 */
async function convertToWav(inputPath: string): Promise<string> {
  const wavPath = inputPath.replace(/\.[^.]+$/, "") + ".wav";
  await execFileAsync(FFMPEG, [
    "-i", inputPath,
    "-ar", "16000",    // 16kHz sample rate
    "-ac", "1",        // mono
    "-c:a", "pcm_s16le", // 16-bit PCM
    "-y",              // overwrite
    wavPath,
  ]);
  return wavPath;
}

export async function transcribe(
  audioPath: string,
  model: string,
  language?: string,
): Promise<string> {
  const modelPath = getModelPath(model);
  if (!modelPath)
    throw new Error(`Model '${model}' not found. Download it first.`);

  // Convert to WAV if not already
  let wavPath = audioPath;
  let needsCleanup = false;
  if (!audioPath.endsWith(".wav")) {
    wavPath = await convertToWav(audioPath);
    needsCleanup = true;
  }

  try {
    const { stdout } = await execFileAsync(WHISPER_CLI, [
      "-m", modelPath,
      "-l", language || "en",
      "--no-timestamps",
      "-f", wavPath,
    ], { maxBuffer: 10 * 1024 * 1024 });

    // Clean up whisper output: remove blank lines, trim whitespace
    const text = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join(" ")
      .trim();

    return text;
  } finally {
    if (needsCleanup) {
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    }
  }
}
