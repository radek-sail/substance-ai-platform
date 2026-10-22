import { Storage, Bucket } from '@google-cloud/storage';

export const storage = new Storage({
  projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCP_PROJECT,
});

/**
 * Resolves the tenant bucket name according to SAIL platform architecture:
 * gs://{customerID}-video-manager-storage/
 */
export function getTenantBucketName(customerId: string): string {
  const suffix = process.env.GCS_BUCKET_SUFFIX || 'video-manager-storage';
  return `${customerId}-${suffix}`;
}

/**
 * Returns a Storage Bucket instance for the specified tenant.
 */
export function getTenantBucket(customerId: string): Bucket {
  const bucketName = getTenantBucketName(customerId);
  return storage.bucket(bucketName);
}

/**
 * Generates the full gs:// URI for an asset inside a tenant bucket.
 */
export function getTenantGcsUri(customerId: string, destinationGcsPath: string): string {
  const bucketName = getTenantBucketName(customerId);
  const cleanDestination = destinationGcsPath.replace(/^\/+/, '');
  return `gs://${bucketName}/${cleanDestination}`;
}

/**
 * Uploads a local file to the tenant's GCS bucket and returns the full gs:// URI.
 *
 * @param customerId - Customer/Tenant identifier
 * @param localFilePath - Path to the local file to upload
 * @param destinationGcsPath - Destination relative path in the tenant bucket
 * @param contentType - MIME type of the uploaded file (defaults to video/mp4)
 * @returns Full gs:// URI, e.g. gs://{customerID}-video-manager-storage/{destinationGcsPath}
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

