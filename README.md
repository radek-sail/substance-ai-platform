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

## 📁 Repository Layout

```text
substance-ai-platform/
├── config/                                  # Versioned multi-pass prompts & agent guidelines
│   ├── classification-agent-guidelines.md   # Pass 0 classifier rules
│   ├── inventory-agent-guidelines.md        # Cryo-inventory tracking rules
│   └── archive-agent-guidelines.md          # Experiment mixing & seeding rules
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