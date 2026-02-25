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
  let processedFilePath: string | undefined;

  try {
    // Save the uploaded file to a temporary file on disk
    await Bun.write(tempFilePath, videoFile);
    processedFilePath = await processVideoForFastStart(tempFilePath);

    // Generate S3 key
    const aspectRatio = await getVideoAspectRatio(processedFilePath);
    const s3Key = `${aspectRatio}/${fileID}.mp4`;

    // Put the object into S3
    await cfg.s3Client.write(
      s3Key,
      file(processedFilePath)
    );

    // Update the VideoURL of the video record in the database
    const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${s3Key}`;
    video.videoURL = videoURL;
    updateVideo(cfg.db, video);

  } finally {
    // Remember to remove the temp file when the process finishes
    await rm(tempFilePath);
    if(processedFilePath) {
      await rm(processedFilePath);
    }
  }

  const updatedVideo = getVideo(cfg.db, video.id);

  return respondWithJSON(200, updatedVideo);
}

async function getVideoAspectRatio(filePath: string): Promise<"landscape" | "portrait" | "other"> {
    const proc = Bun.spawn({
        cmd: [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            filePath,
        ],
        stdout: "pipe",
        stderr: "pipe",
    });

    const stdoutText = await new Response(proc.stdout).text();
    const stderrText = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if(exitCode !== 0){
        throw new Error(`ffprobe failed with exit code ${exitCode}: ${stderrText}`);
    }

    const parsed = JSON.parse(stdoutText);
    const stream = parsed?.streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error("ffprobe did not return valid width/height");
    }

    const ratio = width/height;
    const landscape = 16/9;
    const portrait = 9/16;
    const tolerance = 0.02;

    if(Math.abs(ratio - landscape) <= tolerance)
        return "landscape";
    if(Math.abs(ratio - portrait) <= tolerance)
        return "portrait";

    return "other";
}

async function processVideoForFastStart(inputFilePath: string): Promise<string>{
  const outputFilePath = `${inputFilePath}.processed`;
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath,
    ],
    stdout: "pipe",
    stderr: "pipe"
  });

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`ffmpeg faststart failed with exit code ${exitCode}: ${stderrText || stdoutText}`);
  }

  return outputFilePath;
}