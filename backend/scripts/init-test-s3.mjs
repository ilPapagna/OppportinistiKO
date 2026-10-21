import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
if (process.env.NODE_ENV !== "test") throw new Error("Test-only command");
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});
let last;
for (let attempt = 0; attempt < 15; attempt++) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
    last = null;
    break;
  } catch {
    try {
      await client.send(
        new CreateBucketCommand({
          Bucket: process.env.S3_BUCKET,
          CreateBucketConfiguration: {
            LocationConstraint: process.env.S3_REGION,
          },
        }),
      );
      last = null;
      break;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
client.destroy();
if (last) throw last;
