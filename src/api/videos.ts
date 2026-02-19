import { respondWithJSON } from "./json";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { randomBytes } from "crypto";
import path from "path";
import { rm } from "node:fs/promises";
import { file } from "bun";

// Set an upload limit of 1 GB (1 << 30 bytes)
const MAX_UPLOAD_SIZE = 1 << 30; // 1GB

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading video for video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("Video does not belong to this user");
  }

  const formData = await req.formData();
  const videoFile = formData.get("video");

  if (!(videoFile instanceof File)) {
    throw new BadRequestError("video is not a file");
  }

  if (videoFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(`Video is larger than ${MAX_UPLOAD_SIZE / (1 << 30)}GB`);
  }

  if (videoFile.type !== "video/mp4") {
    throw new BadRequestError("Only MP4 video files are allowed");
  }

  // Create a temporary file
  const fileExtension = path.extname(videoFile.name);
  const fileID = randomBytes(16).toString("hex");
  const tempFileName = `${fileID}${fileExtension}`;
  const tempFilePath = path.join(cfg.filepathRoot, tempFileName);

  try {
    // Save the uploaded file to a temporary file on disk
    await Bun.write(tempFilePath, videoFile);

    // Generate S3 key
    const s3Key = `${fileID}.mp4`;

    // Put the object into S3
    await cfg.s3Client.write(
      s3Key,
      file(tempFilePath)
    );

    // Update the VideoURL of the video record in the database
    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${s3Key}`;
    video.videoURL = videoURL;
    updateVideo(cfg.db, video);

  } finally {
    // Remember to remove the temp file when the process finishes
    await rm(tempFilePath);
  }

  const updatedVideo = getVideo(cfg.db, video.id);

  return respondWithJSON(200, updatedVideo);
}
