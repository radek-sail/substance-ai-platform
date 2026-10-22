# Substance AI Labs (SAIL) — Multimodal Lab Automation Platform

The **Substance AI Labs (SAIL)** platform is an enterprise-grade AI system designed to analyze egocentric laboratory video recordings, extract structured operational events, and automatically maintain biological inventory and experimental notebook records.

The system uses a hierarchical multi-pass AI pipeline powered by Google Gemini multimodal models (`@google/genai`), containerized media normalization with FFmpeg on Google Cloud, and strict multi-tenant Firestore and Google Cloud Storage (GCS) isolation.

---

## 🏗️ High-Level System Architecture

The platform is organized into three unified functional modules:

1. **SAIL Console Subsystem**: Multi-tenant client onboarding, role-based access control via Firebase Auth, dynamic workflow configuration, and guideline specification.
2. **Video Manager Subsystem**: Egocentric video ingestion, cloud-native FFmpeg normalization (H.264/AAC MP4, `+faststart`), and Pass 0 workflow classification.
3. **Workflow Manager Subsystem**: Unified ribbon-based interface for domain operations:
   - **Cell Line Cryo-Inventory Manager**: Cryogenic tank and cryo-box coordinate grid tracking (vial insertion and removal).
   - **Experiment Archive Manager**: Digital laboratory notebook logs, reagent reconstitution, volumetric mixing, and 96-well microplate seeding tracking.
   - **HITL Review & Timeline Editor**: Audio/video waveform alignment, best-shot evidence inspection, inline corrections, and atomic Firestore transaction commits.

---

## ⚡ Hierarchical Multi-Pass AI Pipeline

Complex physical operations are decomposed into isolated, verifiable inference passes:
