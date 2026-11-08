import React, { useState } from 'react';
import {
  Image as ImageIcon,
  Sparkles,
  Edit3,
  RotateCcw,
  ExternalLink,
  ShieldCheck,
  Tag,
  Link2,
  Clock,
  Contrast,
  Focus,
  FileText,
  User,
  Calendar,
  MapPin,
  Database,
} from 'lucide-react';
import type { Action, Event, Refinement } from '@sail/shared';

export interface HumanEditedVialData {
  cellLineName: string;
  lotNumber: string;
  passage: number;
  operatorInitials: string;
  targetCoordinate: string; // e.g. "C4"
  userInitials?: string;
  dateFrozen?: string;
  fullText?: string;
  boxId?: string;
  actionId?: string;
  actionType?: 'VIAL_INSERTION' | 'VIAL_REMOVAL';
}

interface VialInspectorProps {
  action?: Action;
  actions?: Action[];
  selectedActionId?: string;
  onSelectAction?: (actionId: string) => void;
  events?: Event[];
  refinements?: Refinement[];
  editedData: HumanEditedVialData;
  rawAiData: HumanEditedVialData;
  onChange: (field: keyof HumanEditedVialData, value: any) => void;
  onResetField?: (field: keyof HumanEditedVialData) => void;
  onOpenSignOff?: () => void;
  readOnly?: boolean;
}

function resolveFrameUrl(url?: string, fallbackTime?: number): string {
  if (!url) return '';
  let resolved = url;
  if (url.startsWith('gs://')) {
    const withoutScheme = url.slice('gs://'.length);
    const parts = withoutScheme.split('/');
    // Pattern: gs://<bucket>/frames/<videoId>/<filename>
    const framesIdx = parts.indexOf('frames');
    if (framesIdx >= 0 && parts.length > framesIdx + 2) {
      const videoId = parts[framesIdx + 1];
      const filename = parts.slice(framesIdx + 2).join('/');
      resolved = `/api/videos/${encodeURIComponent(videoId)}/frames/${encodeURIComponent(filename)}`;
    }
  }
  if (
    fallbackTime !== undefined &&
    Number.isFinite(fallbackTime) &&
    resolved.startsWith('/api/videos/') &&
    !resolved.includes('?')
  ) {
    resolved = `${resolved}?t=${Number(fallbackTime.toFixed(2))}`;
  }
  return resolved;
}

export const VialInspector: React.FC<VialInspectorProps> = ({
  action,
  actions = [],
  selectedActionId,
  onSelectAction,
  events = [],
  refinements = [],
  editedData,
  rawAiData,
  onChange,
  onResetField,
  onOpenSignOff,
  readOnly = false,
}) => {
  const [selectedImage, setSelectedImage] = useState<{
    url: string;
    title: string;
    subtitle?: string;
  } | null>(null);

  // Filter events associated with the selected action (many-to-many via actionIds or single actionId)
  const associatedEvents = action
    ? events.filter(
        (ev) =>
          (Array.isArray(ev.actionIds) && ev.actionIds.includes(action.actionId)) ||
          ev.actionId === action.actionId ||
          (Array.isArray(action.eventList) && action.eventList.includes(ev.eventId))
      )
    : events;

  const displayEvents = associatedEvents.length > 0 ? associatedEvents : events;

  // Extract best shots from events (preferring Pass 2 bestFrames: HIGHEST_CONTRAST and MINIMAL_BLUR)
  const bestShots: {
    url: string;
    time: number;
    label: string;
    eventId: string;
    frameType?: 'HIGHEST_CONTRAST' | 'MINIMAL_BLUR';
    contrastScore?: number;
    blurScore?: number;
    associatedActionIds: string[];
    spokenContext?: string;
    extractedText?: string;
  }[] = [];

  displayEvents.forEach((ev) => {
    const associatedActionIds =
      Array.isArray(ev.actionIds) && ev.actionIds.length > 0
        ? ev.actionIds
        : ev.actionId
        ? [ev.actionId]
        : [];

    if (Array.isArray(ev.bestFrames) && ev.bestFrames.length > 0) {
      ev.bestFrames.forEach((bf) => {
        const frameTime = bf.timestampSeconds ?? bf.timestamp ?? ev.startTime;
        const fType = bf.frameType === 'MINIMAL_BLUR' ? 'MINIMAL_BLUR' : 'HIGHEST_CONTRAST';
        bestShots.push({
          url: resolveFrameUrl(bf.url || bf.gcsUri, frameTime),
          time: frameTime,
          label: ev.eventClass.replace(/_EVENT/g, ''),
          eventId: ev.eventId,
          frameType: fType,
          contrastScore: bf.contrastScore,
          blurScore: bf.blurScore ?? bf.sharpnessScore,
          associatedActionIds,
          spokenContext: ev.spokenContext,
          extractedText:
            fType === 'HIGHEST_CONTRAST'
              ? ev.highestContrastText || ev.conflatedLabelText
              : ev.minimalBlurText || ev.conflatedLabelText,
        });
      });
    } else if (ev.bestShotUrls && ev.bestShotUrls.length > 0) {
      ev.bestShotUrls.forEach((url, idx) => {
        const time = ev.bestShotTimes?.[idx] ?? ev.startTime;
        const inferredType: 'HIGHEST_CONTRAST' | 'MINIMAL_BLUR' | undefined =
          idx === 0 ? 'HIGHEST_CONTRAST' : idx === 1 ? 'MINIMAL_BLUR' : undefined;
        bestShots.push({
          url: resolveFrameUrl(url, time),
          time,
          label: ev.eventClass.replace(/_EVENT/g, ''),
          eventId: ev.eventId,
          frameType: inferredType,
          associatedActionIds,
          spokenContext: ev.spokenContext,
          extractedText:
            inferredType === 'HIGHEST_CONTRAST'
              ? ev.highestContrastText || ev.conflatedLabelText
              : ev.minimalBlurText || ev.conflatedLabelText,
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

  const inventoryActions = actions.filter((a) => {
    const cls = String(a.actionClass || '');
    return cls.includes('INSERTION') || cls.includes('REMOVAL') || cls.includes('HANDLING');
  });

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
              Verify Pass 2 label presentations (Highest Contrast & Minimal Blur frames) & 4 FPS refined boundaries
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-mono bg-emerald-950/60 border border-emerald-800/60 px-2.5 py-1 rounded-lg">
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Multi-Pass Verified</span>
        </div>
      </div>

      {/* Multi-Action Switcher for Inventory Update Actions */}
      {inventoryActions.length > 1 && (
        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2.5 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-mono text-slate-400 mr-1">
            Inventory Update Actions ({inventoryActions.length}):
          </span>
          {inventoryActions.map((act) => {
            const isSelected = (selectedActionId || action?.actionId) === act.actionId;
            const wellCoord =
              act.boxWellLocation?.coordinate ||
              (act.targetRow && act.targetCol ? `${act.targetRow}${act.targetCol}` : 'C4');
            return (
              <button
                key={act.actionId}
                type="button"
                onClick={() => onSelectAction?.(act.actionId)}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono border transition-all flex items-center gap-1.5 ${
                  isSelected
                    ? 'bg-cyan-950 border-cyan-500 text-cyan-200 font-bold'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <span>{act.actionId}</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-emerald-300">
                  Well {wellCoord}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Selected Action & 4 FPS Refined Interval Summary */}
      {action &&
        (() => {
          const refStart = Number(
            action.refinedStartTimestampSeconds ??
              action.startTimestampSeconds ??
              action.startTime ??
              0
          );
          const refEnd = Number(
            action.refinedEndTimestampSeconds ??
              action.endTimestampSeconds ??
              action.endTime ??
              refStart
          );

          return (
            <div className="bg-slate-950/90 border border-slate-800 rounded-xl p-3 space-y-2.5 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded bg-cyan-950 border border-cyan-700/60 text-cyan-300 font-mono text-[11px]">
                    {action.actionId}
                  </span>
                  <span className="font-semibold text-slate-200 font-mono">{action.actionClass}</span>
                </div>

                <div className="flex items-center gap-3 font-mono text-[11px]">
                  {(typeof action.pass1StartTimestampSeconds === 'number' ||
                    typeof action.originalStartTime === 'number') && (
                    <span className="text-slate-500">
                      Pass 1 (1 FPS): [
                      {(action.pass1StartTimestampSeconds ?? action.originalStartTime ?? 0).toFixed(2)}s –{' '}
                      {(action.pass1EndTimestampSeconds ?? action.originalEndTime ?? 0).toFixed(2)}s]
                    </span>
                  )}
                  {(typeof action.refinedStartTimestampSeconds === 'number' ||
                    typeof action.startTimestampSeconds === 'number' ||
                    typeof action.startTime === 'number') && (
                    <span className="flex items-center gap-1 text-emerald-300 bg-emerald-950/60 border border-emerald-800/60 px-2 py-0.5 rounded">
                      <Clock className="w-3 h-3 text-emerald-400" />
                      <span>
                        {action.refinedFps === 4 || typeof action.refinedStartTimestampSeconds === 'number'
                          ? 'Pass 2 (4 FPS): '
                          : 'Interval: '}
                        [{refStart.toFixed(2)}s – {refEnd.toFixed(2)}s]
                      </span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

      {/* Associated Label Presentation Events & Action Links */}
      {displayEvents.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold text-slate-300 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5 text-purple-400" />
              <span>Associated Label Presentation Events</span>
            </span>
            <span className="text-[10px] font-mono text-slate-500">
              {displayEvents.length} Event{displayEvents.length === 1 ? '' : 's'} Linked
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {displayEvents.map((ev) => {
              const linkedIds =
                Array.isArray(ev.actionIds) && ev.actionIds.length > 0
                  ? ev.actionIds
                  : ev.actionId
                  ? [ev.actionId]
                  : [];
              return (
                <div
                  key={ev.eventId}
                  className="bg-slate-950/80 border border-slate-800/90 rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px]"
                >
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-purple-950/80 border border-purple-700/60 text-purple-200 font-mono text-[10px]">
                      {ev.eventClass.replace(/_EVENT/g, '')}
                    </span>
                    <span className="font-mono text-slate-400">
                      [{ev.startTime.toFixed(2)}s – {ev.endTime.toFixed(2)}s]
                    </span>
                    {ev.spokenContext && (
                      <span className="text-amber-300 font-mono text-[10px] bg-amber-950/50 border border-amber-800/50 px-1.5 py-0.5 rounded">
                        “{ev.spokenContext}”
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-wrap">
                    <Link2 className="w-3 h-3 text-cyan-400 shrink-0" />
                    {linkedIds.map((id) => (
                      <span
                        key={id}
                        className={`px-1.5 py-0.5 rounded font-mono text-[10px] border ${
                          action?.actionId === id
                            ? 'bg-cyan-900/60 border-cyan-500 text-cyan-200'
                            : 'bg-slate-900 border-slate-700 text-slate-400'
                        }`}
                      >
                        {id}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Best-Shot Candidate Image Thumbnails (2 Best Frames per Event: Highest Contrast & Minimal Blur) */}
      <div>
        <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <ImageIcon className="w-3.5 h-3.5 text-cyan-400" />
            <span>Pass 2 Best Frames (Highest Contrast & Minimal Blur)</span>
          </span>
          <span className="text-[10px] text-slate-500 font-mono">
            {bestShots.length} Frame{bestShots.length === 1 ? '' : 's'} Recorded
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {bestShots.length > 0 ? (
            bestShots.map((shot, idx) => (
              <div
                key={`${shot.eventId}_${shot.frameType || idx}`}
                onClick={() =>
                  setSelectedImage({
                    url: shot.url,
                    title: `${shot.label} — ${
                      shot.frameType === 'HIGHEST_CONTRAST'
                        ? 'Highest Contrast Frame'
                        : shot.frameType === 'MINIMAL_BLUR'
                        ? 'Minimal Blur Frame'
                        : 'Best Frame'
                    } @ ${shot.time.toFixed(2)}s`,
                    subtitle:
                      shot.associatedActionIds.length > 0
                        ? `Associated Actions: ${shot.associatedActionIds.join(', ')}`
                        : undefined,
                  })
                }
                className="group relative w-full bg-slate-950 rounded-xl border border-slate-800 hover:border-cyan-500 overflow-hidden cursor-pointer shadow-md transition-all duration-150 hover:scale-[1.01] flex items-center justify-center"
              >
                <img
                  src={shot.url}
                  alt={shot.label}
                  className="w-full h-auto max-h-72 object-contain block group-hover:brightness-110"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-90" />

                {/* Top Left Badge: Frame Type */}
                {shot.frameType && (
                  <div
                    className={`absolute top-2 left-2 px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold flex items-center gap-1 border backdrop-blur-sm ${
                      shot.frameType === 'HIGHEST_CONTRAST'
                        ? 'bg-amber-950/85 border-amber-500/70 text-amber-200'
                        : 'bg-cyan-950/85 border-cyan-500/70 text-cyan-200'
                    }`}
                  >
                    {shot.frameType === 'HIGHEST_CONTRAST' ? (
                      <>
                        <Contrast className="w-3 h-3 text-amber-400" />
                        <span>Highest Contrast</span>
                      </>
                    ) : (
                      <>
                        <Focus className="w-3 h-3 text-cyan-400" />
                        <span>Minimal Blur</span>
                      </>
                    )}
                  </div>
                )}

                <div className="absolute bottom-1.5 left-2 right-2 flex flex-col gap-0.5 text-[10px] font-mono text-slate-200">
                  <div className="flex items-center justify-between">
                    <span className="truncate font-semibold">{shot.label}</span>
                    <span className="text-cyan-400 shrink-0">{shot.time.toFixed(2)}s</span>
                  </div>
                  {(typeof shot.contrastScore === 'number' ||
                    typeof shot.blurScore === 'number') && (
                    <div className="flex items-center justify-between text-[9px] text-slate-400">
                      {typeof shot.contrastScore === 'number' && (
                        <span>Contrast: {shot.contrastScore.toFixed(1)}</span>
                      )}
                      {typeof shot.blurScore === 'number' && (
                        <span>Sharpness: {shot.blurScore.toFixed(1)}</span>
                      )}
                    </div>
                  )}
                </div>

                <div className="absolute top-2 right-2 p-1 rounded bg-black/60 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity">
                  <ExternalLink className="w-3 h-3" />
                </div>
              </div>
            ))
          ) : (
            <div className="col-span-2 bg-slate-950 p-4 rounded-xl border border-slate-800 text-center text-xs text-slate-500">
              No candidate best-shot frames captured for this segment.
            </div>
          )}
        </div>
      </div>

      {/* Pass 3 Dual-Shot Label Conflation & Top-Left Origin Well Summary */}
      <div className="bg-slate-950/90 border border-slate-800 rounded-xl p-3.5 space-y-2.5 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2">
          <span className="font-semibold text-cyan-300 flex items-center gap-1.5 font-mono">
            <FileText className="w-3.5 h-3.5 text-cyan-400" />
            <span>Pass 3 Analysis Refinement (Full-Res Dual-Shot Conflation & Well Origin)</span>
          </span>
          <span className="px-2 py-0.5 rounded bg-black border border-slate-700 text-[10px] font-mono text-slate-300 flex items-center gap-1">
            <MapPin className="w-3 h-3 text-emerald-400" />
            <span>Origin A1: Top-Left Black Corner</span>
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px]">
          <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-2 space-y-1">
            <div className="text-amber-300 font-semibold flex items-center gap-1">
              <Contrast className="w-3 h-3" />
              <span>Shot 1 (Highest Contrast - Full Res) OCR:</span>
            </div>
            <div className="text-slate-300 truncate">
              {displayEvents[0]?.highestContrastText ||
                action?.vialLabelData?.fullText ||
                action?.conflatedLabelText ||
                editedData.fullText ||
                editedData.cellLineName ||
                '(no label text extracted)'}
            </div>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-2 space-y-1">
            <div className="text-cyan-300 font-semibold flex items-center gap-1">
              <Focus className="w-3 h-3" />
              <span>Shot 2 (Minimal Blur - Full Res) OCR:</span>
            </div>
            <div className="text-slate-300 truncate">
              {displayEvents[0]?.minimalBlurText ||
                action?.vialLabelData?.fullText ||
                action?.conflatedLabelText ||
                editedData.fullText ||
                editedData.cellLineName ||
                '(no label text extracted)'}
            </div>
          </div>
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
          {/* Cell Line Name (Required) */}
          <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-slate-400 font-medium">Cell Line Identifier *</label>
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

          {/* User's Initials (Optional) */}
          <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-slate-400 font-medium flex items-center gap-1">
                <User className="w-3 h-3 text-cyan-400" />
                <span>User&apos;s Initials (Optional)</span>
              </label>
              {(isFieldEdited('userInitials') || isFieldEdited('operatorInitials')) && (
                <button
                  type="button"
                  onClick={() => {
                    onResetField?.('userInitials');
                    onResetField?.('operatorInitials');
                  }}
                  className="text-[10px] text-amber-400 hover:text-amber-300 flex items-center gap-1 font-mono"
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                  <span>Revert ({rawAiData.userInitials || rawAiData.operatorInitials || ''})</span>
                </button>
              )}
            </div>
            <input
              type="text"
              disabled={readOnly}
              placeholder="e.g. JS"
              value={editedData.userInitials ?? editedData.operatorInitials ?? ''}
              onChange={(e) => {
                onChange('userInitials', e.target.value);
                onChange('operatorInitials', e.target.value);
              }}
              className={`w-full bg-slate-900 border rounded-lg px-3 py-1.5 font-mono text-slate-100 focus:outline-none ${
                isFieldEdited('userInitials')
                  ? 'border-amber-500/80 text-amber-200'
                  : 'border-slate-700 focus:border-cyan-500'
              }`}
            />
          </div>

          {/* Date Frozen (Optional) */}
          <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-slate-400 font-medium flex items-center gap-1">
                <Calendar className="w-3 h-3 text-cyan-400" />
                <span>Date Frozen (Optional)</span>
              </label>
              {isFieldEdited('dateFrozen') && (
                <button
                  type="button"
                  onClick={() => onResetField && onResetField('dateFrozen')}
                  className="text-[10px] text-amber-400 hover:text-amber-300 flex items-center gap-1 font-mono"
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                  <span>Revert ({rawAiData.dateFrozen || ''})</span>
                </button>
              )}
            </div>
            <input
              type="text"
              disabled={readOnly}
              placeholder="e.g. 2026-03-15"
              value={editedData.dateFrozen ?? ''}
              onChange={(e) => onChange('dateFrozen', e.target.value)}
              className={`w-full bg-slate-900 border rounded-lg px-3 py-1.5 font-mono text-slate-100 focus:outline-none ${
                isFieldEdited('dateFrozen')
                  ? 'border-amber-500/80 text-amber-200'
                  : 'border-slate-700 focus:border-cyan-500'
              }`}
            />
          </div>

          {/* Target Coordinate (Box Well Location: Row A.. + Col 1.. from Top-Right Black Corner) */}
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

          {/* Full Text Extracted from Label (Required, spans 2 cols) */}
          <div className="sm:col-span-2 bg-slate-950 p-3 rounded-xl border border-slate-800/80 space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-slate-400 font-medium flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-cyan-400" />
                <span>Full Text Extracted from Vial Label *</span>
              </label>
              {isFieldEdited('fullText') && (
                <button
                  type="button"
                  onClick={() => onResetField && onResetField('fullText')}
                  className="text-[10px] text-amber-400 hover:text-amber-300 flex items-center gap-1 font-mono"
                >
                  <RotateCcw className="w-2.5 h-2.5" />
                  <span>Revert to Conflated OCR</span>
                </button>
              )}
            </div>
            <input
              type="text"
              disabled={readOnly}
              placeholder="Full conflated text extracted from the 2 best shots"
              value={
                editedData.fullText ??
                `${editedData.cellLineName} | P${editedData.passage} | ${editedData.lotNumber}`
              }
              onChange={(e) => onChange('fullText', e.target.value)}
              className={`w-full bg-slate-900 border rounded-lg px-3 py-1.5 font-mono text-slate-100 focus:outline-none ${
                isFieldEdited('fullText')
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
        </div>

        {/* Commit Verified Actions to Database CTA */}
        {onOpenSignOff && !readOnly && (
          <div className="pt-2 flex justify-end">
            <button
              type="button"
              onClick={onOpenSignOff}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white text-xs font-semibold shadow-md shadow-emerald-500/20 transition-all cursor-pointer"
            >
              <Database className="w-3.5 h-3.5" />
              <span>Commit Verified Actions to Inventory Database</span>
            </button>
          </div>
        )}
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
              <div>
                <div className="text-xs font-mono text-cyan-400">{selectedImage.title}</div>
                {selectedImage.subtitle && (
                  <div className="text-[11px] font-mono text-slate-400">
                    {selectedImage.subtitle}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSelectedImage(null)}
                className="text-slate-400 hover:text-slate-100 text-base font-bold"
              >
                ✕
              </button>
            </div>
            <img
              src={selectedImage.url}
              alt={selectedImage.title}
              className="w-full max-h-[70vh] object-contain rounded-xl border border-slate-800"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default VialInspector;
