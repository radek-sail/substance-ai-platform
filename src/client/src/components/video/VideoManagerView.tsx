import React, { useState } from 'react';
import {
  UploadCloud,
  FileVideo,
  CheckCircle2,
  Loader2,
  Sparkles,
  ArrowRight,
  Building,
  Layers,
} from 'lucide-react';
import type { VideoAnalysisDoc } from '@sail/shared';
import {
  TenantConfig,
  DEFAULT_GCS_BUCKET,
  apiService,
  UploadVideoResponse,
  TriggerAnalysisResponse,
} from '../../services/api.service';

interface VideoManagerViewProps {
  tenant: TenantConfig;
  onSelectVideoForReview: (
    videoId: string,
    workflowType: 'inventory' | 'archive',
    analysis?: VideoAnalysisDoc
  ) => void;
}

export const VideoManagerView: React.FC<VideoManagerViewProps> = ({
  tenant,
  onSelectVideoForReview,
}) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadVideoResponse | null>(null);
  const [analysisResult, setAnalysisResult] = useState<TriggerAnalysisResponse | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
      setUploadResult(null);
      setAnalysisResult(null);
    }
  };

  const handleUploadAndAnalyze = async () => {
    if (!selectedFile) return;
    setIsUploading(true);
    setStatusMessage('Normalizing video with containerized FFmpeg (1080p CRF 17)...');

    try {
      // 1. Upload video
      const uploadRes = await apiService.uploadVideo(selectedFile, {
        customerId: tenant.customerId,
        databaseId: tenant.databaseId,
        fileName: selectedFile.name,
      });
      setUploadResult(uploadRes);

      // 2. Trigger pipeline analysis
      setIsUploading(false);
      setIsAnalyzing(true);
      setStatusMessage('Executing 4-Stage Hierarchical AI Pipeline (Passes 0–3)...');

      const analysisRes = await apiService.triggerAnalysis(
        uploadRes.videoId,
        uploadRes.normalizedGcsUri,
        {
          customerId: tenant.customerId,
          databaseId: tenant.databaseId,
        }
      );
      setAnalysisResult(analysisRes);
      setStatusMessage('Pipeline analysis complete! Ready for Human-in-the-Loop review.');

      const detectedWorkflow =
        analysisRes.analysis?.workflowClassification?.workflowType ||
        analysisRes.analysis?.workloadClassification?.workflowType ||
        analysisRes.summary?.workflowType;
      const targetTab: 'inventory' | 'archive' =
        detectedWorkflow === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ? 'archive' : 'inventory';

      onSelectVideoForReview(uploadRes.videoId, targetTab, analysisRes.analysis);
    } catch (err: any) {
      setStatusMessage(`Error: ${err.message}`);
    } finally {
      setIsUploading(false);
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Upload Box */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-indigo-950 border border-indigo-800 text-indigo-400">
              <UploadCloud className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">
                Egocentric Video Ingestion & Pipeline Orchestration
              </h2>
              <p className="text-xs text-slate-400 font-mono">
                Containerized FFmpeg Normalization + Gemini 3.8 Multi-Pass Analysis
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs font-mono text-cyan-300 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800">
            <Building className="w-3.5 h-3.5 text-cyan-400" />
            <span>gs://{tenant.bucketName || DEFAULT_GCS_BUCKET}/</span>
          </div>
        </div>

        {/* Drag & drop upload area */}
        <label className="border-2 border-dashed border-slate-700 hover:border-cyan-500 rounded-2xl p-8 flex flex-col items-center justify-center cursor-pointer transition-colors bg-slate-950/60 hover:bg-slate-950 group">
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={handleFileChange}
            disabled={isUploading || isAnalyzing}
          />
          <div className="w-14 h-14 rounded-full bg-slate-800 group-hover:bg-cyan-950 text-slate-400 group-hover:text-cyan-400 flex items-center justify-center transition-colors mb-3">
            <FileVideo className="w-7 h-7" />
          </div>
          <span className="text-sm font-semibold text-slate-200">
            {selectedFile ? selectedFile.name : 'Choose raw wet-lab video (.mp4, .mov, .mkv)'}
          </span>
          <span className="text-xs text-slate-500 mt-1">
            {selectedFile
              ? `${(selectedFile.size / (1024 * 1024)).toFixed(1)} MB`
              : 'Egocentric video recorded with head-mounted or benchtop camera'}
          </span>
        </label>

        {/* Action Button */}
        {selectedFile && (
          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-slate-400 font-mono">
              Ready to ingest into tenant: <strong className="text-cyan-300">{tenant.customerId}</strong>
            </span>
            <button
              type="button"
              disabled={isUploading || isAnalyzing}
              onClick={handleUploadAndAnalyze}
              className="flex items-center gap-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-xs px-5 py-2.5 rounded-xl shadow-lg shadow-cyan-500/25 active:scale-95 transition-all"
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Normalizing Video (FFmpeg)...</span>
                </>
              ) : isAnalyzing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Running Passes 0–3...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Upload & Run Multi-Pass Pipeline</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Status message */}
        {statusMessage && (
          <div className="mt-4 p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-cyan-300 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{statusMessage}</span>
            </div>
            {analysisResult && uploadResult && (
              <button
                type="button"
                onClick={() => {
                  const detectedWorkflow =
                    analysisResult.analysis?.workflowClassification?.workflowType ||
                    analysisResult.analysis?.workloadClassification?.workflowType ||
                    analysisResult.summary?.workflowType;
                  const targetTab: 'inventory' | 'archive' =
                    detectedWorkflow === 'EXPERIMENT_NOTEBOOK_WORKFLOW' ? 'archive' : 'inventory';
                  onSelectVideoForReview(uploadResult.videoId, targetTab, analysisResult.analysis);
                }}
                className="flex items-center gap-1.5 bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-300 border border-cyan-500/40 px-3 py-1 rounded-lg text-xs font-semibold transition-colors shrink-0"
              >
                <span>Open Stream ({uploadResult.videoId})</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Pre-Loaded Lab Streams Library for Instant Verification */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
          <Layers className="w-4 h-4 text-cyan-400" />
          <span>Verified Wet-Lab Streams (Instant HITL Inspection)</span>
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Card 1: Cryo-Inventory */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 hover:border-cyan-500/60 transition-all flex flex-col justify-between space-y-3">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold text-cyan-300 bg-cyan-950 px-2 py-0.5 rounded border border-cyan-800">
                  🧊 INVENTORY_UPDATE_WORKFLOW
                </span>
                <span className="text-[10px] text-slate-500 font-mono">00:35.00</span>
              </div>
              <h4 className="text-sm font-semibold text-slate-200 mt-2">
                HEK293T Insertion into Tank Alpha, Tower 2 (Slot C4)
              </h4>
              <p className="text-xs text-slate-400 mt-1">
                Passes 1–3 detected vial presentation, slot C4 differencing, and multi-frame OCR conflation.
              </p>
            </div>

            <button
              type="button"
              onClick={() => onSelectVideoForReview('vid_cryo_demo_01', 'inventory')}
              className="flex items-center justify-center gap-1.5 w-full bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-300 border border-cyan-500/40 text-xs font-semibold py-2 rounded-lg transition-colors"
            >
              <span>Inspect in Cryo-Inventory Manager</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Card 2: Experiment Archive */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 hover:border-emerald-500/60 transition-all flex flex-col justify-between space-y-3">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold text-emerald-300 bg-emerald-950 px-2 py-0.5 rounded border border-emerald-800">
                  🧪 EXPERIMENT_NOTEBOOK_WORKFLOW
                </span>
                <span className="text-[10px] text-slate-500 font-mono">00:45.00</span>
              </div>
              <h4 className="text-sm font-semibold text-slate-200 mt-2">
                96-Well Microplate Seeding & Reconstitution Protocol
              </h4>
              <p className="text-xs text-slate-400 mt-1">
                Detected 100 µL 8-channel pipette seeding across columns 1–6 and resolved DMEM/FBS/P/S acronyms.
              </p>
            </div>

            <button
              type="button"
              onClick={() => onSelectVideoForReview('vid_archive_demo_02', 'archive')}
              className="flex items-center justify-center gap-1.5 w-full bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 text-xs font-semibold py-2 rounded-lg transition-colors"
            >
              <span>Inspect in Experiment Archive Manager</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VideoManagerView;
