import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
// Processing requests currently carry images as base64 data URLs in JSON.
// A 50 MB binary file becomes roughly 67 MB after base64 encoding, before
// JSON overhead, so keep the parser limit above that expanded size.
const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024;
const JSON_REQUEST_LIMIT = "70mb";

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: JSON_REQUEST_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_REQUEST_LIMIT }));

app.use("/api", router);

// body-parser (used by express.json/urlencoded) rejects oversized requests
// before they reach a route. Return the same API error shape as the routes so
// the frontend can explain the problem instead of showing a generic failure.
app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (
    error &&
    typeof error === "object" &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    return res.status(413).json({
      error: `Image payload is too large. Please choose an image no larger than ${MAX_IMAGE_UPLOAD_BYTES / (1024 * 1024)} MB.`,
    });
  }
  return next(error);
});

export default app;
