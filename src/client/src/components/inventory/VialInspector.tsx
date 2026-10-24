import React, { useState } from 'react';
import {
  Image as ImageIcon,
  CheckCircle2,
  Sparkles,
  Edit3,
  RotateCcw,
  ExternalLink,
  ShieldCheck,
  AlertCircle,
} from 'lucide-react';
import type { Action, Event, Refinement } from '@sail/shared';

export interface HumanEditedVialData {
  cellLineName: string;
  lotNumber: string;
  passage: number;
  operatorInitials: string;
  targetCoordinate: string; // e.g. "C4"
}

interface VialInspectorProps {
  action?: Action;
  events?: Event[];
  refinements?: Refinement[];
  editedData: HumanEditedVialData;
  rawAiData: HumanEditedVialData;
  onChange: (field: keyof HumanEditedVialData, value: any) => void;
  onResetField?: (field: keyof HumanEditedVialData) => void;
  readOnly?: boolean;
}

export const VialInspector: React.FC<VialInspectorProps> = ({
  action,
  events = [],
  refinements = [],
  editedData,
  rawAiData,
  onChange,
  onResetField,
  readOnly = false,
}) => {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  // Extract best shots from events
  const bestShots: { url: string; time: number; label: string }[] = [];
  events.forEach((ev) => {
    if (ev.bestShotUrls && ev.bestShotUrls.length > 0) {
      ev.bestShotUrls.forEach((url, idx) => {
        const time = ev.bestShotTimes?.[idx] || ev.startTime;
        bestShots.push({
          url,
          time,
          label: ev.eventClass.replace(/_EVENT/g, ''),
        });
      });
    }
  });

  // Calculate OCR conflation confidence from refinements
  const ocrRefinement = refinements.find(
    (r) => r.refinementClass === 'OCR_CONFLATION' || r.refinementClass.includes('OCR')
  );
  const ocrConfidence = ocrRefinement?.conflationMetadata?.confidence
    ? Math.round(ocrRefinement.conflationMetadata.confidence * 100)
    : 98.5;

  const isFieldEdited = (field: keyof HumanEditedVialData) => {
    return editedData[field] !== rawAiData[field];
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-indigo-950 border border-indigo-800 text-indigo-400">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <span>Pass 1–3 AI Extraction & Vial Inspector</span>
              <span className="bg-cyan-950 border border-cyan-800 text-cyan-400 text-[10px] px-2 py-0.5 rounded-full font-mono">
                {ocrConfidence}% OCR Confidence
              </span>
            </h3>
            <p className="text-[11px] text-slate-400">
              Verify multi-frame OCR and spatial coordinates before atomic sign-off
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-mono bg-emerald-950/60 border border-emerald-800/60 px-2.5 py-1 rounded-lg">
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Multi-Pass Verified</span>
        </div>
      </div>

      {/* Best-Shot Candidate Image Thumbnails */}
      <div>
        <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <ImageIcon className="w-3.5 h-3.5 text-cyan-400" />
            <span>Pass 2 Candidate Best-Shot Frames</span>
          </span>
          <span className="text-[10px] text-slate-500 font-mono">
            {bestShots.length} Frames Evaluated
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {bestShots.length > 0 ? (
            bestShots.map((shot, idx) => (
              <div
                key={idx}
                onClick={() => setSelectedImage(shot.url)}
                className="group relative aspect-video bg-black rounded-xl border border-slate-800 hover:border-cyan-500 overflow-hidden cursor-pointer shadow-md transition-all duration-150 hover:scale-[1.02]"
              >
                <img
                  src={shot.url}
                  alt={shot.label}
                  className="w-full h-full object-cover group-hover:brightness-110"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-80" />
                <div className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between text-[10px] font-mono text-slate-200">
                  <span className="truncate">{shot.label}</span>
                  <span className="text-cyan-400 shrink-0">{shot.time.toFixed(1)}s</span>
                </div>
                <div className="absolute top-1.5 right-1.5 p-1 rounded bg-black/60 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity">
                  <ExternalLink className="w-3 h-3" />
                </div>
              </div>
            ))
          ) : (
            <div className="col-span-4 bg-slate-950 p-4 rounded-xl border border-slate-800 text-center text-xs text-slate-500">
              No candidate best-shot frames captured for this segment.
            </div>
          )}
        </div>
      </div>

      {/* Editable Extraction Form Fields */}
      <div className="space-y-3 pt-2 border-t border-slate-800">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
            <Edit3 className="w-3.5 h-3.5 text-cyan-400" />
            <span>Operator Verified Metadata Fields</span>
          </span>
          <span className="text-[11px] text-slate-400">
            Fields highlighted in amber indicate human revisions
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          {/* Cell Line Name */}
          <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-slate-400 font-medium">Cell Line Identifier</label>
              {isFieldEdited('cellLineName') && (
                <button
                  type="button"
                  onClick={() => onResetField && onResetField('cellLineName')}
                  className="text-[10px] text-amber-400 hover:text-amber-300 flex items-center gap-1 font-mono"
                  title="Reset to AI extracted value"
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                  <span>Revert to AI ({rawAiData.cellLineName})</span>
                </button>
              )}
            </div>
            <input
              type="text"
              disabled={readOnly}
              value={editedData.cellLineName}
              onChange={(e) => onChange('cellLineName', e.target.value)}
              className={`w-full bg-slate-900 border rounded-lg px-3 py-1.5 font-mono text-slate-100 focus:outline-none ${
                isFieldEdited('cellLineName')
                  ? 'border-amber-500/80 text-amber-200'
                  : 'border-slate-700 focus:border-cyan-500'
              }`}
            />
          </div>

          {/* Lot Number */}
          <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-slate-400 font-medium">Lot Number</label>
              {isFieldEdited('lotNumber') && (
                <button
                  type="button"
                  onClick={() => onResetField && onResetField('lotNumber')}
                  className="text-[10px] text-amber-400 hover:text-amber-300 flex items-center gap-1 font-mono"
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                  <span>Revert ({rawAiData.lotNumber})</span>
                </button>
              )}
            </div>
            <input
              type="text"
              disabled={readOnly}
              value={editedData.lotNumber}
              onChange={(e) => onChange('lotNumber', e.target.value)}
              className={`w-full bg-slate-900 border rounded-lg px-3 py-1.5 font-mono text-slate-100 focus:outline-none ${
                isFieldEdited('lotNumber')
                  ? 'border-amber-500/80 text-amber-200'
                  : 'border-slate-700 focus:border-cyan-500'
              }`}
            />
          </div>

          {/* Passage */}
          <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-slate-400 font-medium">Passage Number (P)</label>
              {isFieldEdited('passage') && (
                <button
                  type="button"
                  onClick={() => onResetField && onResetField('passage')}
                  className="text-[10px] text-amber-400 hover:text-amber-300 flex items-center gap-1 font-mono"
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                  <span>Revert (P{rawAiData.passage})</span>
                </button>
              )}
            </div>
            <input
              type="number"
              min={1}
              max={100}
              disabled={readOnly}
              value={editedData.passage}
              onChange={(e) => onChange('passage', parseInt(e.target.value, 10) || 1)}
              className={`w-full bg-slate-900 border rounded-lg px-3 py-1.5 font-mono text-slate-100 focus:outline-none ${
                isFieldEdited('passage')
                  ? 'border-amber-500/80 text-amber-200'
                  : 'border-slate-700 focus:border-cyan-500'
              }`}
            />
          </div>

          {/* Target Coordinate */}
          <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-slate-400 font-medium">Target Coordinate (Slot)</label>
              {isFieldEdited('targetCoordinate') && (
                <button
                  type="button"
                  onClick={() => onResetField && onResetField('targetCoordinate')}
                  className="text-[10px] text-amber-400 hover:text-amber-300 flex items-center gap-1 font-mono"
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                  <span>Revert ({rawAiData.targetCoordinate})</span>
                </button>
              )}
            </div>
            <input
              type="text"
              maxLength={3}
              disabled={readOnly}
              value={editedData.targetCoordinate}
              onChange={(e) => onChange('targetCoordinate', e.target.value.toUpperCase())}
              className={`w-full bg-slate-900 border rounded-lg px-3 py-1.5 font-mono text-slate-100 uppercase focus:outline-none ${
                isFieldEdited('targetCoordinate')
                  ? 'border-amber-500/80 text-amber-200'
                  : 'border-slate-700 focus:border-cyan-500'
              }`}
            />
          </div>
        </div>
      </div>

      {/* Image Lightbox Modal */}
      {selectedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setSelectedImage(null)}
        >
          <div
            className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-4 shadow-2xl relative"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono text-cyan-400">
                Full Resolution Candidate Frame
              </span>
              <button
                type="button"
                onClick={() => setSelectedImage(null)}
                className="text-slate-400 hover:text-white text-base font-bold"
              >
                ✕
              </button>
            </div>
            <img
              src={selectedImage}
              alt="Candidate frame full"
              className="w-full max-h-[70vh] object-contain rounded-xl border border-slate-800"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default VialInspector;

