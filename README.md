# Substance AI Labs (SAIL) — Multimodal Lab Automation Platform

The **Substance AI Labs (SAIL)** platform analyzes egocentric video recordings of wet-lab procedures, detects physical operational events, and automatically updates biological inventory records and digital experiment notebooks.

The platform executes a hierarchical multi-pass AI pipeline using Google Gemini models via `@google/genai`, containerized FFmpeg video normalization on Google Cloud Run, and strict multi-tenant isolation across Firestore and Google Cloud Storage (GCS).

---

## 🏗️ System Architecture & Subsystems

The monorepo encompasses three primary application subsystems:

1. **SAIL Console**: Customer onboarding, tenant database and bucket provisioning, RBAC user assignment via Firebase Auth, and workflow guideline configuration (`config/*-agent-guidelines.md`).
2. **Video Manager**: Ingestion of raw egocentric video, cloud-native FFmpeg normalization (H.264/AAC MP4, 1080p, `+faststart`), and Pass 0 audio classification.
3. **Workflow Manager**: Unified ribbon interface supporting:
   - **Cell Line Cryo-Inventory Manager**: Cryogenic tank and cryo-box coordinate grid tracking (vial insertions and removals).
   - **Experiment Archive Manager**: Digital lab notebook logging, reagent reconstitution, volumetric mixing, and 96-well microplate seeding tracking.
   - **HITL Review & Timeline Editor**: Audio/video waveform alignment, best-shot frame review, inline field correction, and atomic Firestore transaction commits.

---

## ⚡ Hierarchical Multi-Pass AI Pipeline

The pipeline decomposes complex laboratory activities into discrete, verifiable passes:

```
Raw / Normalized Video
          │
          ▼
┌────────────────────────────────────────┐
│ Pass 0: Workflow Classification        │  ──► workloadClassification.json
│ (Gemini Flash @ 1 fps)                 │
└──────────────────┬─────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────┐
│ Pass 1: Action Detection               │  ──► action_detection_pass.json
│ (Gemini Pro @ 1 fps)                   │
└──────────────────┬─────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────┐
│ Pass 2: Event Detection (Temporal)     │  ──► event_detection_pass.json
│ (Gemini Flash/Pro @ 4 fps)             │
└──────────────────┬─────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────┐
│ Pass 3: Analysis Refinement            │  ──► analysis_refinement_pass.json
│ (Gemini Pro @ Full Resolution Crop)    │
└──────────────────┬─────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────┐
│ Human-in-the-Loop (HITL) Verification  │  ──► Atomic Firestore Commit
└────────────────────────────────────────┘
```

- **Pass 0 (Workflow Classifier)**: Scans initial operator speech against `config/classification-agent-guidelines.md` to classify streams (`INVENTORY_UPDATE_WORKFLOW`, `EXPERIMENT_NOTEBOOK_WORKFLOW`, or `UNCLASSIFIED_WORKFLOW`).
- **Pass 1 (Action Detection)**: Detects high-level compound actions over wide temporal spans (`VIAL_INSERTION_ACTION`, `REAGENT_MIXING_ACTION`, `REAGENT_SEEDING_ACTION`).
- **Pass 2 (Event Detection)**: Extracts fine-grained sub-events (label presentations, pre/post-action states), timestamps, and candidate best-shot frame image URLs.
- **Pass 3 (Refinement)**: Executes targeted perceptual reasoning: multi-frame OCR conflation, spatial coordinate differencing from the top-left origin (lettered rows, numbered columns), and spoken parameter verification.

---

## Architecture & Video Ingestion

The platform utilizes a decoupled, asynchronous video ingestion pipeline designed for high-resolution egocentric recordings (e.g., Meta Ray-Ban glasses capturing 10-bit HEVC variable-framerate footage up to 120fps) and large multi-gigabyte video files.

```
Browser Client                    Express Backend (Cloud Run)                 Google Cloud Storage (GCS)             Cloud Firestore
      │                                       │                                           │                                │
      │ 1. POST /api/videos/request-upload-url │                                           │                                │
      ├──────────────────────────────────────►│                                           │                                │
      │    Returns V4 Signed PUT URL          │                                           │                                │
      │◄──────────────────────────────────────┤                                           │                                │
      │                                       │                                           │                                │
      │ 2. Direct HTTP PUT (raw video stream) │                                           │                                │
      ├──────────────────────────────────────────────────────────────────────────────────►│ gs://<BUCKET>/raw/<videoId>/   │
      │                                       │                                           │                                │
      │ 3. POST /api/videos/finalize-upload   │                                           │                                │
      ├──────────────────────────────────────►│ 4. Register status: 'TRANSCODING'         │                                │
      │                                       ├───────────────────────────────────────────────────────────────────────────►│ videos/{videoId}
      │    HTTP 202 Accepted                  │                                           │                                │
      │◄──────────────────────────────────────┤ 5. Background download & FFmpeg transcode │                                │
      │                                       │    - 8-bit format=yuv420p                 │                                │
      │                                       │    - Cap framerate: -r 30                 │                                │
      │                                       │    - Preset: ultrafast, CRF: 23           │                                │
      │                                       │    - 10-min chunk segmentation            │                                │
      │                                       │                                           │                                │
      │                                       │ 6. Upload 10-minute normalized chunks     │                                │
      │                                       ├──────────────────────────────────────────►│ normalized/<videoId>/chunk_*.mp4│
      │                                       │                                           │                                │
      │                                       │ 7. Update status: 'READY_FOR_ANALYSIS'    │                                │
      │                                       ├───────────────────────────────────────────────────────────────────────────►│ videos/{videoId}
```

### Direct-to-GCS Presigned URLs
- Client calls `POST /api/videos/request-upload-url` to receive a Google Cloud Storage V4 Signed URL.
- Raw video files (including large >2GB files) stream directly from the browser to `gs://<BUCKET_NAME>/raw/<videoId>/`, completely bypassing Express server memory to eliminate Cloud Run Out-Of-Memory (OOM) crashes.

### Asynchronous Containerized Transcoding
- Client notifies the backend via `POST /api/videos/finalize-upload`.
- The endpoint registers the video in Cloud Firestore `videos/{videoId}` with `status: 'TRANSCODING'` and immediately returns `HTTP 202 Accepted` to prevent HTTP 504 gateway timeouts.
- The server downloads the raw file, executes containerized FFmpeg to normalize the video (forcing 8-bit `format=yuv420p`, capping framerate at 30fps with `-r 30`, and using `-preset ultrafast`), and splits the stream into 10-minute segments.
- Segments are uploaded to `gs://<BUCKET_NAME>/normalized/<videoId>/chunk_%03d.mp4`, and the Firestore document status transitions to `READY_FOR_ANALYSIS`.

---

## Deployment & Cloud Run Configuration

Cloud Run requires explicit runtime flags to prevent container execution from being throttled between requests and to supply adequate compute resources for containerized FFmpeg transcoding.

### Deployment / Update Command
```bash
gcloud run services update sail-platform \
  --region us-west1 \
  --no-cpu-throttling \
  --timeout=3600 \
  --cpu=2 \
  --memory=2Gi
```

### Runtime Flag Requirements
- `--no-cpu-throttling`: Guarantees container CPU remains fully allocated after returning HTTP 202 so background FFmpeg transcoding runs continuously.
- `--timeout=3600`: Increases request timeout threshold to 60 minutes.
- `--cpu=2` and `--memory=2Gi`: Provides the necessary compute power and memory for FFmpeg decoding and chunking.

---

## Google Cloud Storage & IAM Prerequisites

Browser uploads via presigned URLs and server-side V4 signing require specific bucket CORS configuration and IAM roles on Google Cloud.

### Bucket CORS Configuration
To apply bucket CORS for browser uploads:
```bash
gcloud storage buckets update gs://<BUCKET_NAME> --cors-file=config/gcs-cors.json
```

`config/gcs-cors.json` permits `GET`, `PUT`, `POST`, `HEAD`, `OPTIONS` from `*` with headers `Content-Type` and `x-goog-resumable`:
```json
[
  {
    "origin": ["*"],
    "method": ["GET", "PUT", "POST", "HEAD", "OPTIONS"],
    "responseHeader": ["Content-Type", "x-goog-resumable"],
    "maxAgeSeconds": 3600
  }
]
```

### Required IAM Roles
The Cloud Run runtime service account (`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`) requires the following IAM roles:
- `roles/datastore.user` (Firestore native read/write)
- `roles/storage.objectAdmin` (GCS bucket read/write)
- `roles/iam.serviceAccountTokenCreator` (Required by the GCS SDK to generate V4 signed PUT URLs via `signBlob`)

---

## 📁 Repository Layout

```text
substance-ai-platform/
├── config/                                  # Versioned multi-pass prompts & agent guidelines
│   ├── classification-agent-guidelines.md   # Pass 0 classifier rules
│   ├── inventory-agent-guidelines.md        # Cryo-inventory tracking rules
│   ├── archive-agent-guidelines.md          # Experiment mixing & seeding rules
│   └── gcs-cors.json                        # GCS CORS policy for direct browser uploads
├── src/
│   ├── client/                              # Vite + React 18+ SPA
│   │   ├── components/                      # Common UI, Inventory, Archive, Timeline
│   │   ├── hooks/                           # Custom React state & pipeline hooks
│   │   └── services/                        # Client API wrappers
│   ├── server/                              # Node.js / Express backend service
│   │   ├── controllers/                     # Ingestion, pipeline, and tenant controllers
│   │   ├── services/                        # gemini.service, ffmpeg.service, firestore.service
│   │   ├── routes/                          # REST routing layer
│   │   └── server.ts                        # Server entrypoint
│   └── shared/
│       └── types/
│           └── pipeline.ts                  # Canonical Zod schemas & TypeScript definitions
├── AGENTS.md                                # Autonomous coding agent (Antigravity) directives
├── Dockerfile                               # Cloud Run container bundling FFmpeg & Node.js
├── package.json
└── tsconfig.json
```

---

## ☁️ Google Cloud & Multi-Tenant Infrastructure

No local media processing dependencies are required. All video normalization and heavy extraction tasks execute remotely:

### 1. Backend Container (Cloud Run)
The backend container runs on Debian Slim with `ffmpeg` installed. Video normalization enforces:
```bash
ffmpeg -y -i <input_video> \
  -c:v libx264 -preset veryfast -crf 17 -pix_fmt yuv420p \
  -vf "scale=-2:'min(1080,ih)':flags=bicubic" \
  -c:a copy -movflags +faststart \
  <output_normalized.mp4>
```

### 2. Multi-Tenant Data Scoping
- **Cloud Storage**: `gs://{customerID}-video-manager-storage/{uploads|normalized|frames}/`
- **Firestore**: `/databases/{databaseID}/documents/{videos|inventories|inventory_contents|archives|video_analyses}`

---

## 🤖 Development with Coding Agents

This repository is maintained collaboratively by human developers and autonomous coding agents (e.g., Google Antigravity):

1. **Strict Type Contracts**: All pipeline payloads must conform to the Zod schemas in `src/shared/types/pipeline.ts`.
2. **Externalized Prompts**: System instructions and prompt templates must remain in `config/*-agent-guidelines.md` rather than being hardcoded in controllers.
3. **Agent Directives**: Refer to `AGENTS.md` for specific development rules and architecture constraints.

---

## 🚀 Getting Started

### Environment Variables
Create a `.env` file in the project root:
```bash
PORT=8080
GOOGLE_GENAI_API_KEY=your_gemini_api_key
FIREBASE_PROJECT_ID=your_firebase_project_id
GCS_BUCKET_SUFFIX=video-manager-storage
```

### Installation & Local Development
```bash
# Install workspace dependencies
npm install

# Start client development server
npm run dev

# Run TypeScript typechecks
npm run typecheck
```

### Container Build & Deployment (Google Cloud)
```bash
# Build and submit container image
gcloud builds submit --tag gcr.io/[PROJECT_ID]/sail-backend

# Deploy backend to Cloud Run
gcloud run deploy sail-backend \
  --image gcr.io/[PROJECT_ID]/sail-backend \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated
```
