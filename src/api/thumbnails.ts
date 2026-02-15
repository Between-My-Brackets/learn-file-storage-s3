import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import {
  BadRequestError,
  NotFoundError,
  UserForbiddenError,
} from "./errors";



export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const imageFile = formData.get("thumbnail");

  if (!(imageFile instanceof File)) {
    throw new BadRequestError("thumbnail is not a file");
  }

  const MAX_UPLOAD_SIZE = 10 << 20; // 10MB

  if (imageFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("thumbnail is larger than 10MB");
  }

  const mediaType = imageFile.type;
  const imageBlob = await imageFile.arrayBuffer();

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("Video does not belong to this user");
  }

  const imageBuffer = Buffer.from(imageBlob);
  const imageBase64 = imageBuffer.toString("base64");
  const thumbnailURL = `data:${mediaType};base64,${imageBase64}`;

  video.thumbnailURL = thumbnailURL;

  updateVideo(cfg.db, video);

  const updatedVideo = getVideo(cfg.db, video.id);

  return respondWithJSON(200, updatedVideo);
}
