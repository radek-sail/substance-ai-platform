import React, { useMemo } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';
import type { Action, Event } from '@sail/shared';
import { Clock, Activity, Tag, Sparkles } from 'lucide-react';

interface TimelineViewerProps {
  duration: number;
  currentTime: number;
  actions: Action[];
  events: Event[];
  selectedActionId?: string | null;
  selectedEventId?: string | null;
  onSeek: (time: number) => void;
  onSelectAction: (actionId: string) => void;
  onSelectEvent: (eventId: string) => void;
}

export const TimelineViewer: React.FC<TimelineViewerProps> = ({
  duration = 35.0,
  currentTime,
  actions = [],
  events = [],
  selectedActionId,
  selectedEventId,
  onSeek,
  onSelectAction,
  onSelectEvent,
}) => {
  // Generate synthetic audio/optical-flow energy waveform points based on duration
  const waveformData = useMemo(() => {
    const pointsCount = 70;
    const data = [];
    for (let i = 0; i <= pointsCount; i++) {
      const t = (i / pointsCount) * duration;
      // Synthesize realistic audio energy spikes during events
      let energy = 15 + Math.sin(i * 0.4) * 10 + Math.cos(i * 0.8) * 8;
      for (const ev of events) {
        if (t >= ev.startTime && t <= ev.endTime) {
          energy += 45 + Math.random() * 20;
        }
      }
      data.push({
        time: parseFloat(t.toFixed(1)),
        energy: Math.min(100, Math.max(10, Math.round(energy))),
      });
    }
    return data;
  }, [duration, events]);

  // Current scrubber percentage
  const playheadPercent = Math.max(0, Math.min(100, (currentTime / (duration || 35)) * 100));

  const getEventBadgeColor = (eventClass: string) => {
    if (eventClass.includes('LABEL')) return 'bg-purple-600/30 border-purple-500 text-purple-200';
    if (eventClass.includes('PRE_ACTION')) return 'bg-amber-600/30 border-amber-500 text-amber-200';
    if (eventClass.includes('POST_ACTION')) return 'bg-teal-600/30 border-teal-500 text-teal-200';
    if (eventClass.includes('INSERTION')) return 'bg-cyan-600/30 border-cyan-500 text-cyan-200';
    if (eventClass.includes('SEEDING')) return 'bg-emerald-600/30 border-emerald-500 text-emerald-200';
    if (eventClass.includes('REAGENT') || eventClass.includes('ASPIRATION'))
      return 'bg-blue-600/30 border-blue-500 text-blue-200';
    return 'bg-slate-700/50 border-slate-600 text-slate-300';
  };

  const getActionBadgeColor = (actionClass: string) => {
    if (actionClass.includes('INSERTION')) return 'from-cyan-900/60 to-blue-900/60 border-cyan-500/70 text-cyan-200';
    if (actionClass.includes('REMOVAL')) return 'from-rose-900/60 to-red-900/60 border-rose-500/70 text-rose-200';
    if (actionClass.includes('SEEDING'))
      return 'from-emerald-900/60 to-teal-900/60 border-emerald-500/70 text-emerald-200';
    return 'from-indigo-900/60 to-violet-900/60 border-indigo-500/70 text-indigo-200';
  };

  const handleRulerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    onSeek(ratio * duration);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl select-none flex flex-col gap-3">
      {/* Header bar */}
      <div className="flex items-center justify-between text-xs pb-1 border-b border-slate-800">
        <div className="flex items-center gap-2 font-semibold text-slate-200">
          <Activity className="w-4 h-4 text-cyan-400" />
          <span>Synchronized Multi-Pass Timeline</span>
          <span className="text-[11px] font-mono text-slate-500">
            (Pass 1 Actions & Pass 2 Events)
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-cyan-300">
          <Clock className="w-3.5 h-3.5" />
          <span>{currentTime.toFixed(2)}s</span>
        </div>
      </div>

      {/* Synchronized Recharts Waveform View */}
      <div className="h-16 w-full bg-slate-950/60 rounded-xl p-1 relative border border-slate-800/80">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={waveformData} margin={{ top: 4, right: 0, left: -40, bottom: 0 }}>
            <defs>
              <linearGradient id="audioEnergyGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.7} />
                <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="time" hide />
            <YAxis hide domain={[0, 100]} />
            <Tooltip
              content={({ payload }) => {
                if (payload && payload.length) {
                  return (
                    <div className="bg-slate-900 text-[10px] font-mono text-cyan-300 px-2 py-1 rounded border border-slate-700 shadow">
                      Energy: {payload[0].value}%
                    </div>
                  );
                }
                return null;
              }}
            />
            <Area
              type="monotone"
              dataKey="energy"
              stroke="#22d3ee"
              strokeWidth={1.5}
              fillOpacity={1}
              fill="url(#audioEnergyGrad)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>

        {/* Dynamic Needle overlay on waveform */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)] pointer-events-none z-10 transition-all duration-75"
          style={{ left: `${playheadPercent}%` }}
        >
          <div className="w-2.5 h-2.5 bg-red-500 rounded-full -ml-1 -top-1 absolute shadow-sm" />
        </div>
      </div>

      {/* Interactive Timeline Tracks Container */}
      <div
        className="relative bg-slate-950 border border-slate-800 rounded-xl p-2.5 cursor-crosshair group flex flex-col gap-2"
        onClick={handleRulerClick}
      >
        {/* Track 1: Action Track (Pass 1) */}
        <div>
          <div className="text-[10px] font-mono uppercase text-slate-500 tracking-wider mb-1 flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-cyan-400" />
            <span>Pass 1: Compound Actions Track</span>
          </div>

          <div className="relative h-9 bg-slate-900/80 rounded-lg border border-slate-800/80 overflow-hidden">
            {actions.map((act) => {
              // Action span calculation
              const actionEvents = events.filter((e) => act.eventList?.includes(e.eventId));
              const start = actionEvents.length > 0 ? Math.min(...actionEvents.map((e) => e.startTime)) : 0;
              const end = actionEvents.length > 0 ? Math.max(...actionEvents.map((e) => e.endTime)) : duration;
              const leftPercent = Math.max(0, Math.min(100, (start / duration) * 100));
              const widthPercent = Math.max(8, Math.min(100 - leftPercent, ((end - start) / duration) * 100));
              const isSelected = selectedActionId === act.actionId;

              return (
                <div
                  key={act.actionId}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeek(start);
                    onSelectAction(act.actionId);
                  }}
                  className={`absolute top-1 bottom-1 rounded-md px-2 flex items-center justify-between text-[11px] font-medium border bg-gradient-to-r cursor-pointer transition-all duration-150 hover:brightness-125 ${getActionBadgeColor(
                    act.actionClass
                  )} ${
                    isSelected ? 'ring-2 ring-cyan-400 shadow-lg shadow-cyan-500/30 brightness-110' : ''
                  }`}
                  style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
                  title={`${act.actionClass} (${start.toFixed(1)}s - ${end.toFixed(1)}s)`}
                >
                  <span className="truncate font-mono">{act.actionClass}</span>
                  <span className="text-[10px] opacity-75 font-mono ml-1 hidden sm:inline">
                    {start.toFixed(0)}s–{end.toFixed(0)}s
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Track 2: Event Track (Pass 2) */}
        <div>
          <div className="text-[10px] font-mono uppercase text-slate-500 tracking-wider mb-1 flex items-center gap-1">
            <Tag className="w-3 h-3 text-purple-400" />
            <span>Pass 2: Temporal Sub-Events & Best-Shots</span>
          </div>

          <div className="relative h-10 bg-slate-900/80 rounded-lg border border-slate-800/80 overflow-hidden">
            {events.map((ev) => {
              const leftPercent = Math.max(0, Math.min(100, (ev.startTime / duration) * 100));
              const widthPercent = Math.max(
                4,
                Math.min(100 - leftPercent, ((ev.endTime - ev.startTime) / duration) * 100)
              );
              const isSelected = selectedEventId === ev.eventId;

              return (
                <div
                  key={ev.eventId}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeek(ev.startTime);
                    onSelectEvent(ev.eventId);
                  }}
                  className={`absolute top-1 bottom-1 rounded-md px-1.5 flex items-center gap-1 text-[10px] font-mono border cursor-pointer transition-all duration-150 hover:scale-[1.02] hover:z-20 ${getEventBadgeColor(
                    ev.eventClass
                  )} ${
                    isSelected ? 'ring-2 ring-purple-400 shadow-md shadow-purple-500/40 z-10' : ''
                  }`}
                  style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
                  title={`${ev.eventClass} [${ev.startTime.toFixed(1)}s - ${ev.endTime.toFixed(1)}s]`}
                >
                  {ev.bestShotUrls && ev.bestShotUrls.length > 0 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0 shadow-sm shadow-cyan-400" />
                  )}
                  <span className="truncate">{ev.eventClass.replace(/_EVENT|_SPAN/g, '')}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Time ruler ticks */}
        <div className="relative h-4 mt-1 border-t border-slate-800 flex items-center text-[9px] font-mono text-slate-500">
          {[0, 0.25, 0.5, 0.75, 1.0].map((fraction) => {
            const tickTime = (fraction * duration).toFixed(1);
            return (
              <span
                key={fraction}
                className="absolute -translate-x-1/2"
                style={{ left: `${fraction * 100}%` }}
              >
                {tickTime}s
              </span>
            );
          })}
        </div>

        {/* Vertical red needle that tracks current video position */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.9)] pointer-events-none z-30 transition-all duration-75"
          style={{ left: `${playheadPercent}%` }}
        >
          <div className="w-3 h-3 bg-red-500 rotate-45 -ml-1.5 -top-1.5 absolute shadow-md shadow-red-500/50" />
        </div>
      </div>
    </div>
  );
};

export default TimelineViewer;

