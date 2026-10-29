const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Set test environment
process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT_ID = 'test-sail-project';
process.env.GCS_BUCKET_SUFFIX = 'video-manager-storage';

const {
  normalizeDatabaseId,
  getTenantFirestore,
  saveVideoMetadata,
  getVideoMetadata,
  clearDatabaseCache,
} = require('../dist/services/firestore.service');

const {
  getTenantBucketName,
  getTenantGcsUri,
  uploadToTenantStorage,
  storage,
} = require('../dist/services/storage.service');

const {
  NORMALIZATION_FFMPEG_OPTIONS,
  normalizeVideo,
  extractCandidateFrame,
} = require('../dist/services/ffmpeg.service');

const {
  getScratchDir,
  uploadVideoHandler,
} = require('../dist/controllers/video.controller');

const { app } = require('../dist/server');

describe('Phase 2: Multi-Tenant Data & Media Engine', () => {
  describe('Firestore Service', () => {
    beforeEach(() => {
      clearDatabaseCache();
    });

    it('should normalize database IDs from both raw IDs and full resource paths', () => {
      assert.strictEqual(normalizeDatabaseId('customer-alpha'), 'customer-alpha');
      assert.strictEqual(
        normalizeDatabaseId('/databases/customer-alpha/documents/'),
        'customer-alpha'
      );
      assert.strictEqual(
        normalizeDatabaseId('projects/p/databases/customer-beta/documents'),
        'customer-beta'
      );
      assert.strictEqual(normalizeDatabaseId(), '(default)');
      assert.strictEqual(normalizeDatabaseId(''), '(default)');
    });

    it('should cache and return Firestore instances scoped to the tenant database', () => {
      const db1 = getTenantFirestore('tenant-a');
      const db2 = getTenantFirestore('tenant-a');
      const db3 = getTenantFirestore('tenant-b');

      assert.strictEqual(db1, db2, 'Expected identical cached instance for same tenant');
      assert.notStrictEqual(db1, db3, 'Expected distinct instance for different tenant');
      assert.strictEqual(db1.databaseId, 'tenant-a');
      assert.strictEqual(db3.databaseId, 'tenant-b');
      assert.ok(
        db1.formattedName.includes('/databases/tenant-a'),
        'Instance must be scoped to tenant database'
      );
    });

    it('should update the tenant videos collection via saveVideoMetadata', async () => {
      const db = getTenantFirestore('test-tenant');

      let savedDocId = null;
      let savedData = null;
      let mergeOption = null;

      // Mock collection on the cached Firestore instance
      const origCollection = db.collection.bind(db);
      db.collection = (collectionName) => {
        assert.strictEqual(collectionName, 'videos');
        return {
          doc: (docId) => {
            savedDocId = docId;
            return {
              set: async (data, options) => {
                savedData = data;
                mergeOption = options;
                return { writeTime: new Date() };
              },
            };
          },
        };
      };

      try {
        const metadata = {
          videoId: 'vid-123',
          customerId: 'cust-456',
          databaseId: 'test-tenant',
          originalGcsUri: 'gs://cust-456-video-manager-storage/uploads/vid-123.mp4',
          normalizedGcsUri: 'gs://cust-456-video-manager-storage/normalized/norm_vid-123.mp4',
          status: 'NORMALIZED',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await saveVideoMetadata('test-tenant', 'vid-123', metadata);

        assert.strictEqual(savedDocId, 'vid-123');
        assert.deepStrictEqual(savedData, metadata);
        assert.deepStrictEqual(mergeOption, { merge: true });
      } finally {
        db.collection = origCollection;
      }
    });
  });

  describe('Storage Service', () => {
    it('should resolve tenant bucket according to gs://{customerID}-video-manager-storage/', () => {
      const bucketName = getTenantBucketName('acme-corp');
      assert.strictEqual(bucketName, 'acme-corp-video-manager-storage');
    });

    it('should format full gs:// URI correctly', () => {
      const uri = getTenantGcsUri('acme-corp', 'uploads/video_001.mp4');
      assert.strictEqual(
        uri,
        'gs://acme-corp-video-manager-storage/uploads/video_001.mp4'
      );

      const uriWithLeadingSlash = getTenantGcsUri('acme-corp', '/normalized/norm_video_001.mp4');
      assert.strictEqual(
        uriWithLeadingSlash,
        'gs://acme-corp-video-manager-storage/normalized/norm_video_001.mp4'
      );
    });

    it('should upload local file to tenant storage and return gs:// URI', async () => {
      const tempFile = path.join(os.tmpdir(), `test_upload_${Date.now()}.mp4`);
      fs.writeFileSync(tempFile, 'dummy-video-content');

      let uploadedDestination = null;
      let uploadedMetadata = null;
      let requestedBucketName = null;

      const origBucket = storage.bucket.bind(storage);
      storage.bucket = (bName) => {
        requestedBucketName = bName;
        return {
          name: bName,
          upload: async (_filePath, options) => {
            uploadedDestination = options.destination;
            uploadedMetadata = options.metadata;
            return [{}];
          },
        };
      };

      try {
        const resultUri = await uploadToTenantStorage(
          'tenant-xyz',
          tempFile,
          'uploads/test.mp4',
          'video/mp4'
        );

        assert.strictEqual(
          resultUri,
          'gs://tenant-xyz-video-manager-storage/uploads/test.mp4'
        );
        assert.strictEqual(requestedBucketName, 'tenant-xyz-video-manager-storage');
        assert.strictEqual(uploadedDestination, 'uploads/test.mp4');
        assert.deepStrictEqual(uploadedMetadata, { contentType: 'video/mp4' });
      } finally {
        storage.bucket = origBucket;
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      }
    });
  });

  describe('FFmpeg Service', () => {
    it('should strictly enforce required normalization options', () => {
      assert.ok(
        NORMALIZATION_FFMPEG_OPTIONS.includes('-c:v libx264'),
        'Must enforce -c:v libx264'
      );
      assert.ok(
        NORMALIZATION_FFMPEG_OPTIONS.includes('-preset veryfast'),
        'Must enforce -preset veryfast'
      );
      assert.ok(
        NORMALIZATION_FFMPEG_OPTIONS.includes('-crf 17'),
        'Must enforce -crf 17'
      );
      assert.ok(
        NORMALIZATION_FFMPEG_OPTIONS.includes('-pix_fmt yuv420p'),
        'Must enforce -pix_fmt yuv420p'
      );
      assert.ok(
        NORMALIZATION_FFMPEG_OPTIONS.some((opt) => opt.includes('scale=-2:\'min(1080,ih)\':flags=bicubic')),
        'Must enforce bicubic 1080p scale filter'
      );
      assert.ok(
        NORMALIZATION_FFMPEG_OPTIONS.includes('-c:a copy'),
        'Must enforce -c:a copy'
      );
      assert.ok(
        NORMALIZATION_FFMPEG_OPTIONS.includes('-movflags +faststart'),
        'Must enforce -movflags +faststart'
      );
    });

    it('should have callable normalizeVideo and extractCandidateFrame functions', () => {
      assert.strictEqual(typeof normalizeVideo, 'function');
      assert.strictEqual(typeof extractCandidateFrame, 'function');
    });
  });

  describe('Video Controller & Ingestion Pipeline', () => {
    it('should return 400 if x-customer-id header is missing', async () => {
      let statusCode = null;
      let jsonBody = null;

      const req = {
        headers: { 'x-database-id': 'db-1' },
        body: {},
      };
      const res = {
        status: (code) => {
          statusCode = code;
          return {
            json: (data) => {
              jsonBody = data;
            },
          };
        },
      };

      await uploadVideoHandler(req, res);
      assert.strictEqual(statusCode, 400);
      assert.ok(jsonBody.error.includes('x-customer-id'));
    });

    it('should return 400 if x-database-id header is missing', async () => {
      let statusCode = null;
      let jsonBody = null;

      const req = {
        headers: { 'x-customer-id': 'cust-1' },
        body: {},
      };
      const res = {
        status: (code) => {
          statusCode = code;
          return {
            json: (data) => {
              jsonBody = data;
            },
          };
        },
      };

      await uploadVideoHandler(req, res);
      assert.strictEqual(statusCode, 400);
      assert.ok(jsonBody.error.includes('x-database-id'));
    });

    it('should return 400 if no video file or path is provided', async () => {
      let statusCode = null;
      let jsonBody = null;

      const req = {
        headers: {
          'x-customer-id': 'cust-1',
          'x-database-id': 'db-1',
        },
        body: {},
      };
      const res = {
        status: (code) => {
          statusCode = code;
          return {
            json: (data) => {
              jsonBody = data;
            },
          };
        },
      };

      await uploadVideoHandler(req, res);
      assert.strictEqual(statusCode, 400);
      assert.ok(jsonBody.error.includes('No valid video file'));
    });

    it('should successfully orchestrate multi-tenant upload, normalization, firestore record, and cleanup', async () => {
      const scratchDir = getScratchDir();
      const testVideoId = 'test-vid-999';
      const inputVideoFile = path.join(scratchDir, `input_${testVideoId}.mp4`);
      fs.writeFileSync(inputVideoFile, 'sample-raw-video-bytes');

      const storageService = require('../dist/services/storage.service');
      const ffmpegService = require('../dist/services/ffmpeg.service');
      const firestoreService = require('../dist/services/firestore.service');

      const uploadCalls = [];
      const origUpload = storageService.uploadToTenantStorage;
      storageService.uploadToTenantStorage = async (customerId, localFile, dest, contentType) => {
        uploadCalls.push({ customerId, localFile, dest, contentType });
        return `gs://${customerId}-video-manager-storage/${dest}`;
      };

      let normalizedCalledWith = null;
      const origNormalize = ffmpegService.normalizeVideo;
      ffmpegService.normalizeVideo = async (input, output) => {
        normalizedCalledWith = { input, output };
        fs.writeFileSync(output, 'sample-normalized-video-bytes');
        return output;
      };

      let savedFirestoreData = null;
      const origSaveMetadata = firestoreService.saveVideoMetadata;
      firestoreService.saveVideoMetadata = async (dbId, vId, meta) => {
        savedFirestoreData = { dbId, vId, meta };
        return { writeTime: new Date() };
      };

      let statusCode = null;
      let jsonBody = null;

      const req = {
        headers: {
          'x-customer-id': 'biolab-inc',
          'x-database-id': 'biolab-db',
          'x-video-id': testVideoId,
        },
        file: {
          path: inputVideoFile,
          originalname: 'experiment_run1.mp4',
        },
        body: {},
      };

      const res = {
        status: (code) => {
          statusCode = code;
          return {
            json: (data) => {
              jsonBody = data;
            },
          };
        },
      };

      try {
        await uploadVideoHandler(req, res);

        assert.strictEqual(statusCode, 201);
        assert.strictEqual(jsonBody.success, true);
        assert.strictEqual(jsonBody.videoId, testVideoId);
        assert.strictEqual(jsonBody.customerId, 'biolab-inc');
        assert.strictEqual(jsonBody.databaseId, 'biolab-db');
        assert.strictEqual(
          jsonBody.originalGcsUri,
          'gs://biolab-inc-video-manager-storage/uploads/test-vid-999.mp4'
        );
        assert.strictEqual(
          jsonBody.normalizedGcsUri,
          'gs://biolab-inc-video-manager-storage/normalized/norm_test-vid-999.mp4'
        );

        // Verify uploads
        assert.strictEqual(uploadCalls.length, 2);
        assert.strictEqual(uploadCalls[0].dest, 'uploads/test-vid-999.mp4');
        assert.strictEqual(uploadCalls[1].dest, 'normalized/norm_test-vid-999.mp4');

        // Verify normalization target was /tmp/norm_{videoId}.mp4
        assert.ok(
          normalizedCalledWith.output.endsWith(`norm_${testVideoId}.mp4`),
          'Normalization output filename must be norm_{videoId}.mp4'
        );

        // Verify Firestore record
        assert.strictEqual(savedFirestoreData.dbId, 'biolab-db');
        assert.strictEqual(savedFirestoreData.vId, testVideoId);
        assert.strictEqual(savedFirestoreData.meta.status, 'NORMALIZED');

        // Verify scratch file cleanup
        assert.strictEqual(
          fs.existsSync(inputVideoFile),
          false,
          'Uploaded scratch file must be deleted'
        );
        assert.strictEqual(
          fs.existsSync(normalizedCalledWith.output),
          false,
          'Normalized scratch file must be deleted'
        );
      } finally {
        storageService.uploadToTenantStorage = origUpload;
        ffmpegService.normalizeVideo = origNormalize;
        firestoreService.saveVideoMetadata = origSaveMetadata;
        if (fs.existsSync(inputVideoFile)) fs.unlinkSync(inputVideoFile);
      }
    });
  });

  describe('Server & Routes', () => {
    it('should serve /health and /api/health check', async () => {
      const server = app.listen(0);
      const port = server.address().port;

      try {
        const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
        assert.strictEqual(healthRes.status, 200);
        const healthData = await healthRes.json();
        assert.strictEqual(healthData.status, 'ok');
        assert.strictEqual(healthData.service, '@sail/server');

        const apiHealthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
        assert.strictEqual(apiHealthRes.status, 200);
        const apiHealthData = await apiHealthRes.json();
        assert.strictEqual(apiHealthData.status, 'ok');
      } finally {
        server.close();
      }
    });

    it('should respond with 400 when POST /api/videos/upload is called without tenant headers', async () => {
      const server = app.listen(0);
      const port = server.address().port;

      try {
        const uploadRes = await fetch(`http://127.0.0.1:${port}/api/videos/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        });

        assert.strictEqual(uploadRes.status, 400);
        const data = await uploadRes.json();
        assert.ok(data.error.includes('x-customer-id'));
      } finally {
        server.close();
      }
    });

    it('should persist uploaded video to Firestore and return { videos } from GET /api/videos', async () => {
      const firestoreService = require('../dist/services/firestore.service');
      const nowIso = new Date().toISOString();
      await firestoreService.saveVideoMetadata('(default)', 'vid_registry_test_01', {
        videoId: 'vid_registry_test_01',
        originalName: '20260828_115859_c5d6b3be.mp4',
        gcsBucket: 'sail-platform-videos',
        normalizedGcsUri: 'gs://sail-platform-videos/normalized/norm_vid_registry_test_01.mp4',
        status: 'READY_FOR_ANALYSIS',
        uploadedAt: nowIso,
        passes: {
          pass0: { status: 'PENDING' },
          pass1: { status: 'PENDING' },
          pass2: { status: 'PENDING' },
          pass3: { status: 'PENDING' },
          hitl: { status: 'PENDING' },
        },
      });

      const server = app.listen(0);
      const port = server.address().port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/videos`);
        assert.strictEqual(res.status, 200);
        const payload = await res.json();
        assert.ok(Array.isArray(payload.videos), 'GET /api/videos should return { videos: [...] }');
        const found = payload.videos.find((v) => v.videoId === 'vid_registry_test_01');
        assert.ok(found, 'Uploaded video must be present in GET /api/videos response');
        assert.strictEqual(found.originalName, '20260828_115859_c5d6b3be.mp4');
        assert.strictEqual(found.status, 'READY_FOR_ANALYSIS');
        assert.strictEqual(found.passes.pass0.status, 'PENDING');
      } finally {
        server.close();
      }
    });
  });
});

