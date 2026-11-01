"use strict";

const { spawn } = require("node:child_process");
const sharp = require("sharp");

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARS = 30000;
const DEFAULT_TIMEOUT_MS = 25000;

function normalizeOcrText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

async function preprocessImage(input) {
  return sharp(input, { limitInputPixels: 40000000 })
    .rotate()
    .resize({ width: 2400, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .sharpen()
    .jpeg({ quality: 92 })
    .toBuffer();
}

function recognizeWithTesseract(input, options = {}) {
  const executable = options.executable || process.env.TESSERACT_PATH || "tesseract";
  const language = options.language || process.env.OCR_LANGUAGES || "ara+eng";
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const pageSegmentationMode = String(options.pageSegmentationMode ?? options.psm ?? "6");
  if (!/^(?:3|6|11)$/.test(pageSegmentationMode)) throw new Error("ocr_invalid_page_segmentation_mode");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["stdin", "stdout", "-l", language, "--psm", pageSegmentationMode], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("ocr_timeout"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.length > MAX_TEXT_CHARS * 2) {
        child.kill("SIGKILL");
        finish(new Error("ocr_output_limit"));
      }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on("error", error => finish(new Error(`ocr_engine_unavailable: ${error.code || error.message}`)));
    child.on("close", code => {
      if (code !== 0) return finish(new Error(`ocr_failed: exit=${code}; ${stderr.trim().slice(0, 300)}`));
      finish(null, stdout);
    });
    child.stdin.on("error", error => finish(new Error(`ocr_input_failed: ${error.code || error.message}`)));
    child.stdin.end(input);
  });
}

function createImageOcr(options = {}) {
  const prepare = options.preprocess || preprocessImage;
  const recognize = options.recognize || recognizeWithTesseract;
  return {
    async extract(input, metadata = {}) {
      if (!Buffer.isBuffer(input) || input.length === 0) throw new Error("ocr_image_buffer_required");
      if (input.length > (options.maxImageBytes || MAX_IMAGE_BYTES)) throw new Error("ocr_image_too_large");
      const prepared = await prepare(input, metadata);
      const rawText = await recognize(prepared, options);
      const text = normalizeOcrText(rawText);
      return {
        text,
        hasText: text.length > 0,
        characterCount: text.length,
        language: options.language || process.env.OCR_LANGUAGES || "ara+eng",
        engine: "tesseract"
      };
    }
  };
}

module.exports = {
  createImageOcr,
  normalizeOcrText,
  preprocessImage,
  recognizeWithTesseract,
  MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS
};
