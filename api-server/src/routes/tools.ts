import { Router, type IRouter } from "express";
import { ProcessImageBody, ProcessImageParams } from "@workspace/api-zod";
import { processWithReplicate } from "../lib/replicate";

const router: IRouter = Router();
const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

let credits = 24;
let imagesProcessed = 0;
const activity: Array<{
  id: string;
  tool: string;
  label: string;
  timestamp: string;
  status: string;
}> = [];

function getImagePayloadSize(imageData: string): { mimeType: string; bytes: number } | null {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageData);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  if (!ACCEPTED_IMAGE_TYPES.has(mimeType)) return null;
  const base64 = match[2];
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return { mimeType, bytes: Math.floor((base64.length * 3) / 4) - padding };
}

router.post("/tools/:tool/process", async (req, res): Promise<void> => {
  const params = ProcessImageParams.safeParse(req.params);
  const body = ProcessImageBody.safeParse(req.body);

  if (!params.success || !body.success) {
    return res.status(400).json({ error: "Please upload a valid image file." });
  }
  const imagePayload = getImagePayloadSize(body.data.imageData);
  if (!imagePayload) {
    return res.status(400).json({ error: "Please upload a JPG, JPEG, PNG, or WEBP image." });
  }
  if (imagePayload.bytes > MAX_IMAGE_UPLOAD_BYTES) {
    return res.status(413).json({
      error: "Image payload is too large. Please choose an image no larger than 50 MB.",
    });
  }
  if (credits < 1) {
    res.status(400).json({ error: "You’re out of credits. Upgrade to keep creating." });
    return;
  }

  let processedImage: string;
  let provider: string;
  try {
    ({ processedImage, provider } = await processWithReplicate({
      tool: params.data.tool,
      imageData: body.data.imageData,
      background: body.data.background,
      prompt: body.data.prompt,
      enhancement: body.data.enhancement,
    }));
  } catch (error) {
    req.log.error({ err: error, tool: params.data.tool }, "Replicate image processing failed");
    res.status(502).json({
      error: error instanceof Error
        ? error.message
        : "The image provider could not process this image. Please try again.",
    });
    return;
  }

  credits -= 1;
  imagesProcessed += 1;
  const id = `replicate-${Date.now()}`;
  const label =
    params.data.tool === "background-remover"
      ? "Background removed"
      : params.data.tool === "background-changer"
        ? "Background changed"
        : "Image enhanced";
  activity.unshift({
    id,
    tool: params.data.tool,
    label,
    timestamp: new Date().toISOString(),
    status: "completed",
  });

  req.log.info({ tool: params.data.tool, provider, fileName: body.data.fileName }, "Image processed");
  res.json({
    id,
    tool: params.data.tool,
    originalImage: body.data.imageData,
    processedImage,
    status: "completed",
    creditsRemaining: credits,
    message: `Processed with ${provider}.`,
  });
});

router.get("/dashboard", (_req, res) => {
  res.json({
    plan: "Free",
    credits,
    monthlyCredits: 25,
    imagesProcessed,
    activeSubscription: false,
    providerConfigured: true,
  });
});

router.get("/activity", (_req, res) => {
  res.json(activity.slice(0, 10));
});

export default router;