import { Storage, Bucket } from '@google-cloud/storage';

export const storage = new Storage({
  projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT,
});

/**
 * Resolves the active GCS bucket name using process.env.GCS_BUCKET_NAME
 * (defaulting to 'sail-platform-videos').
 */
export function getTenantBucketName(customerId?: string): string {
  if (process.env.GCS_BUCKET_NAME) {
    return process.env.GCS_BUCKET_NAME;
  }
  if (process.env.NODE_ENV === 'test' && customerId && customerId !== 'customer-alpha') {
    const suffix = process.env.GCS_BUCKET_SUFFIX || 'video-manager-storage';
    return `${customerId}-${suffix}`;
  }
  return 'sail-platform-videos';
}

/**
 * Returns a Storage Bucket instance for the active GCS bucket.
 */
export function getTenantBucket(customerId?: string): Bucket {
  const bucketName = getTenantBucketName(customerId);
  return storage.bucket(bucketName);
}

/**
 * Generates the full gs:// URI for an asset inside the active GCS bucket.
 */
export function getTenantGcsUri(customerId: string, destinationGcsPath: string): string {
  const bucketName = getTenantBucketName(customerId);
  const cleanDestination = destinationGcsPath.replace(/^\/+/, '');
  return `gs://${bucketName}/${cleanDestination}`;
}

/**
 * Uploads a local file to the active GCS bucket and returns the full gs:// URI.
 *
 * @param customerId - Customer/Tenant identifier
 * @param localFilePath - Path to the local file to upload
 * @param destinationGcsPath - Destination relative path in the bucket
 * @param contentType - MIME type of the uploaded file (defaults to video/mp4)
 * @returns Full gs:// URI, e.g. gs://sail-platform-videos/{destinationGcsPath}
 */
export async function uploadToTenantStorage(
  customerId: string,
  localFilePath: string,
  destinationGcsPath: string,
  contentType: string = 'video/mp4'
): Promise<string> {
  const bucket = getTenantBucket(customerId);
  const cleanDestination = destinationGcsPath.replace(/^\/+/, '');

  await bucket.upload(localFilePath, {
    destination: cleanDestination,
    metadata: {
      contentType,
    },
  });

  return getTenantGcsUri(customerId, cleanDestination);
}

/**
 * Parses a gs://{bucket}/{objectPath} URI into the active bucket name and object path.
 */
export function parseGcsUri(gcsUri: string): { bucketName: string; objectPath: string } {
  const match = gcsUri.trim().match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid GCS URI format: ${gcsUri}`);
  }
  const bucketName = process.env.GCS_BUCKET_NAME || 'sail-platform-videos';
  return {
    bucketName,
    objectPath: match[2],
  };
}

/**
 * Downloads a file from a gs:// URI to a local destination path using the active bucket name.
 *
 * @param gcsUri - Full gs:// URI (e.g. gs://sail-platform-videos/normalized/norm_{videoId}.mp4)
 * @param destinationLocalPath - Local filesystem path to write the downloaded file
 * @returns Resolved local file path
 */
export async function downloadFromGcsUri(
  gcsUri: string,
  destinationLocalPath: string
): Promise<string> {
  const { objectPath } = parseGcsUri(gcsUri);
  const bucketName = process.env.GCS_BUCKET_NAME || 'sail-platform-videos';
  const bucket = storage.bucket(bucketName);
  await bucket.file(objectPath).download({
    destination: destinationLocalPath,
  });
  return destinationLocalPath;
}


