import { ReplitConnectors } from "@replit/connectors-sdk";
import sharp from "sharp";

const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024;
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 80;

type ReplicatePrediction = {
  id: string;
  status: string;
  output?: unknown;
  error?: string | null;
};

type ProcessImageOptions = {
  tool: "background-remover" | "background-changer" | "image-enhancer";
  imageData: string;
  background?: string;
  prompt?: string;
  enhancement?: "standard" | "hd";
};

function decodeDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error("The uploaded image is not a supported data URL.");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("Image payload is too large. Please choose an image no larger than 50 MB.");
  }
  return { buffer, mimeType: match[1] };
}

function asJson(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function findOutputUrl(value: unknown): string | undefined {
  if (typeof value === "string" && /^https?:\/\//.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findOutputUrl(item);
      if (url) return url;
    }
  }
  if (value && typeof value === "object") {
    for (const candidate of Object.values(value as Record<string, unknown>)) {
      const url = findOutputUrl(candidate);
      if (url) return url;
    }
  }
  return undefined;
}

function modelForTool(tool: ProcessImageOptions["tool"]): string {
  if (tool === "background-remover") return process.env.REMOVEX_BACKGROUND_REMOVER_MODEL ?? "bria/remove-background";
  if (tool === "background-changer") return process.env.REMOVEX_BACKGROUND_CHANGER_MODEL ?? "black-forest-labs/flux-fill-dev";
  return process.env.REMOVEX_ENHANCER_MODEL ?? "nightmareai/real-esrgan";
}

async function replicateRequest(
  connection: ReplitConnectors,
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await connection.proxy("replicate", path, init);
  const raw = await response.text();
  let payload: unknown = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { detail: raw };
  }
  if (!response.ok) {
    const body = asJson(payload);
    throw new Error(String(body.detail ?? body.error ?? body.title ?? `Replicate request failed (${response.status})`));
  }
  return asJson(payload);
}

async function uploadFile(
  connection: ReplitConnectors,
  dataUrl: string,
): Promise<string> {
  const { buffer, mimeType } = decodeDataUrl(dataUrl);
  const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const form = new FormData();
  form.append("content", new Blob([buffer], { type: mimeType }), `removex-upload.${extension}`);
  const uploaded = await replicateRequest(connection, "/v1/files", {
    method: "POST",
    body: form,
  });
  const url = uploaded.urls && asJson(uploaded.urls).get;
  if (typeof url !== "string") throw new Error("Replicate did not return an upload URL.");
  return url;
}

async function getLatestModelVersion(
  connection: ReplitConnectors,
  model: string,
): Promise<string> {
  const [owner, name] = model.split("/");
  if (!owner || !name) throw new Error(`Invalid Replicate model name: ${model}`);
  const details = await replicateRequest(connection, `/v1/models/${owner}/${name}`, { method: "GET" });
  const version = asJson(details.latest_version).id;
  if (typeof version !== "string") throw new Error(`Replicate model ${model} has no current version.`);
  return version;
}

async function runPrediction(
  connection: ReplitConnectors,
  model: string,
  input: Record<string, unknown>,
): Promise<string> {
  const configuredVersion = process.env[`REMOVEX_${model.replace(/[^A-Z0-9]/gi, "_").toUpperCase()}_VERSION`];
  const version = configuredVersion ?? await getLatestModelVersion(connection, model);
  const prediction = await replicateRequest(connection, "/v1/predictions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "wait=60" },
    body: JSON.stringify({ version, input }),
  }) as ReplicatePrediction;

  let current = prediction;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    if (current.status === "succeeded") break;
    if (["failed", "canceled"].includes(current.status)) {
      throw new Error(current.error || `Replicate prediction ${current.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    current = await replicateRequest(connection, `/v1/predictions/${current.id}`, { method: "GET" }) as ReplicatePrediction;
  }
  if (current.status !== "succeeded") throw new Error("Replicate processing timed out. Please try again.");
  const outputUrl = findOutputUrl(current.output);
  if (!outputUrl) throw new Error("Replicate completed without an image output.");
  return outputUrl;
}

async function downloadAsDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download the processed image (${response.status}).`);
  const contentType = response.headers.get("content-type")?.split(";")[0] || "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

export async function processWithReplicate(options: ProcessImageOptions): Promise<{
  processedImage: string;
  provider: string;
}> {
  const connectors = new ReplitConnectors();
  const sourceUrl = await uploadFile(connectors, options.imageData);
  const model = modelForTool(options.tool);
  let input: Record<string, unknown>;

  if (options.tool === "background-remover") {
    input = { image: sourceUrl };
  } else if (options.tool === "image-enhancer") {
    input = {
      image: sourceUrl,
      scale: options.enhancement === "standard" ? 2 : 4,
    };
  } else {
    const backgroundUrl = options.background?.startsWith("data:image/")
      ? await uploadFile(connectors, options.background)
      : undefined;
    input = {
      image: sourceUrl,
      mask: backgroundUrl ?? sourceUrl,
      prompt: options.prompt || options.background || "a realistic professional studio background",
    };
  }

  // Background replacement models need a mask. Use the removal model first
  // when no separately uploaded background exists, then invert its alpha
  // channel into the white-fill mask expected by FLUX Fill.
  if (options.tool === "background-changer" && !options.background?.startsWith("data:image/")) {
    const removedUrl = await runPrediction(connectors, "bria/remove-background", { image: sourceUrl });
    const removedResponse = await fetch(removedUrl);
    const removedBuffer = Buffer.from(await removedResponse.arrayBuffer());
    const maskBuffer = await sharp(removedBuffer).ensureAlpha().extractChannel("alpha").negate().png().toBuffer();
    const maskDataUrl = `data:image/png;base64,${maskBuffer.toString("base64")}`;
    input.mask = await uploadFile(connectors, maskDataUrl);
  }

  const outputUrl = await runPrediction(connectors, model, input);
  return { processedImage: await downloadAsDataUrl(outputUrl), provider: model };
}