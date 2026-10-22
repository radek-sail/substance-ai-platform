# Agent Directives & Architecture Rules (SAIL Platform)

1. Architecture Alignment:
   - Adhere strictly to the System Architecture Document.
   - Do not create split domain repositories. All workflows (Inventory & Archive) live in this monorepo.

2. Media Processing:
   - All FFmpeg commands run inside Linux containers or Cloud Run jobs.
   - Video normalization must enforce:
     ffmpeg -y -i <input> -c:v libx264 -preset veryfast -crf 17 -pix_fmt yuv420p -vf "scale=-2:'min(1080,ih)':flags=bicubic" -c:a copy -movflags +faststart <output>

3. Pipeline Modularity:
   - Prompts must not be hardcoded in TypeScript files. They must be loaded dynamically from `config/*-agent-guidelines.md`.
   - All AI inputs/outputs must validate through `src/shared/types/pipeline.ts` Zod schemas.

4. Multi-Tenant Storage:
   - Firestore paths: `/databases/{databaseID}/documents/`
   - GCS paths: `gs://{customerID}-video-manager-storage/`