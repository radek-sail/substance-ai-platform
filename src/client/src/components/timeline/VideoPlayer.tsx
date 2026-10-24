import React, { useRef, useEffect, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Volume2,
  VolumeX,
  Gauge,
  FastForward,
  Rewind,
  Maximize2,
} from 'lucide-react';

export interface VideoPlayerProps {
  src?: string;
  currentTime: number;
  duration?: number;
  isPlaying: boolean;
  onTimeUpdate: (time: number) => void;
  onDurationChange: (duration: number) => void;
  onPlayPause: (playing: boolean) => void;
  seekTarget?: number | null;
  onSeekHandled?: () => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src,
  currentTime,
  duration = 35.0,
  isPlaying,
  onTimeUpdate,
  onDurationChange,
  onPlayPause,
  seekTarget,
  onSeekHandled,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [isMuted, setIsMuted] = useState<boolean>(true);
  const [useSyntheticCanvas, setUseSyntheticCanvas] = useState<boolean>(!src);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentTimeRef = useRef<number>(currentTime);
  currentTimeRef.current = currentTime;

  // Sync seekTarget from external timeline clicks
  useEffect(() => {
    if (seekTarget !== null && seekTarget !== undefined) {
      if (videoRef.current) {
        videoRef.current.currentTime = seekTarget;
      }
      onTimeUpdate(seekTarget);
      if (onSeekHandled) {
        onSeekHandled();
      }
    }
  }, [seekTarget, onSeekHandled, onTimeUpdate]);

  // Sync isPlaying state with video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.play().catch(() => {
        // Video autoplay policy fallback
        setUseSyntheticCanvas(true);
      });
    } else {
      video.pause();
    }
  }, [isPlaying]);

  // Sync playback speed
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  // Fallback synthetic video canvas renderer for lab simulation
  useEffect(() => {
    let animId: number;
    const canvas = canvasRef.current;
    if (!canvas || !useSyntheticCanvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const renderSynthetic = () => {
      ctx.fillStyle = '#090d16';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Lab viewport grid
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      const step = 40;
      for (let x = 0; x < canvas.width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      // Simulated Egocentric Camera Crosshair
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 32, 0, 2 * Math.PI);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx - 48, cy);
      ctx.lineTo(cx - 16, cy);
      ctx.moveTo(cx + 16, cy);
      ctx.lineTo(cx + 48, cy);
      ctx.moveTo(cx, cy - 48);
      ctx.lineTo(cx, cy - 16);
      ctx.moveTo(cx, cy + 16);
      ctx.lineTo(cx, cy + 48);
      ctx.stroke();

      // Lab telemetry overlay
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 16px monospace';
      ctx.fillText(`EGOCENTRIC CAMERA FEED [CAM-01]`, 20, 36);

      ctx.fillStyle = '#38bdf8';
      ctx.font = '13px monospace';
      ctx.fillText(`TIMESTAMP: ${currentTime.toFixed(2)}s / ${duration.toFixed(2)}s`, 20, 60);
      ctx.fillText(`FRAME: ${Math.floor(currentTime * 30)} (30 fps)`, 20, 80);

      // Activity indicators
      let activity = 'OPERATOR STANDBY';
      if (currentTime >= 3 && currentTime < 9) {
        activity = 'PASS 2: VIAL_LABEL_PRESENTATION_EVENT';
      } else if (currentTime >= 9 && currentTime < 15) {
        activity = 'PASS 3: PRE_ACTION_BOX_SCAN';
      } else if (currentTime >= 15 && currentTime < 23) {
        activity = 'PASS 1: VIAL_INSERTION_ACTION -> SLOT C4';
      } else if (currentTime >= 23) {
        activity = 'PASS 3: POST_ACTION_BOX_SCAN (SLOT C4 OCCUPIED)';
      }

      ctx.fillStyle = '#a855f7';
      ctx.font = 'bold 14px monospace';
      ctx.fillText(`DETECTED: ${activity}`, 20, canvas.height - 24);

      if (isPlaying) {
        animId = requestAnimationFrame(renderSynthetic);
      }
    };

    renderSynthetic();

    return () => cancelAnimationFrame(animId);
  }, [useSyntheticCanvas, currentTime, duration, isPlaying]);

  // Handle synthetic time progression if real video fails or is absent
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (useSyntheticCanvas && isPlaying) {
      interval = setInterval(() => {
        const next = currentTimeRef.current + 0.1 * playbackSpeed;
        onTimeUpdate(next >= duration ? 0 : next);
      }, 100);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [useSyntheticCanvas, isPlaying, playbackSpeed, duration, onTimeUpdate]);

  const handleStep = (deltaSeconds: number) => {
    const newTime = Math.max(0, Math.min(duration, currentTime + deltaSeconds));
    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
    }
    onTimeUpdate(newTime);
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.floor((secs % 1) * 100);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl flex flex-col">
      {/* Video Viewport */}
      <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden group">
        {!useSyntheticCanvas && src ? (
          <video
            ref={videoRef}
            src={src}
            muted={isMuted}
            playsInline
            className="w-full h-full object-contain"
            onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
            onDurationChange={(e) => onDurationChange(e.currentTarget.duration)}
            onError={() => setUseSyntheticCanvas(true)}
            onEnded={() => onPlayPause(false)}
          />
        ) : (
          <canvas
            ref={canvasRef}
            width={640}
            height={360}
            className="w-full h-full object-contain"
          />
        )}

        {/* Big play/pause overlay on hover */}
        <button
          type="button"
          onClick={() => onPlayPause(!isPlaying)}
          className="absolute inset-0 m-auto w-16 h-16 rounded-full bg-cyan-600/60 backdrop-blur-sm border border-cyan-400/40 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:scale-110 active:scale-95 duration-200"
        >
          {isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
        </button>

        {/* Top telemetry pill */}
        <div className="absolute top-3 left-3 bg-black/70 backdrop-blur-md border border-slate-700/60 px-3 py-1 rounded-full flex items-center gap-2 text-[11px] font-mono text-cyan-400">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span>REC 1080p 30fps</span>
          <span className="text-slate-500">|</span>
          <span className="text-slate-300">SUB-SECOND SYNC</span>
        </div>
      </div>

      {/* Programmatic Playback Controls Bar */}
      <div className="bg-slate-950/90 px-4 py-3 border-t border-slate-800 space-y-2 select-none">
        {/* Scrubber slider */}
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={duration || 35.0}
            step={0.05}
            value={currentTime}
            onChange={(e) => {
              const target = parseFloat(e.target.value);
              if (videoRef.current) {
                videoRef.current.currentTime = target;
              }
              onTimeUpdate(target);
            }}
            className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400 hover:accent-cyan-300 transition-all"
          />
        </div>

        {/* Button controls */}
        <div className="flex items-center justify-between text-xs">
          {/* Left: Play, Pause, Step Buttons */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onPlayPause(!isPlaying)}
              className="p-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={() => handleStep(-1.0)}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
              title="Step backward 1.0s"
            >
              <Rewind className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => handleStep(-0.1)}
              className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px]"
              title="Step backward 1 frame (0.1s)"
            >
              -0.1s
            </button>

            <button
              type="button"
              onClick={() => handleStep(0.1)}
              className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px]"
              title="Step forward 1 frame (0.1s)"
            >
              +0.1s
            </button>

            <button
              type="button"
              onClick={() => handleStep(1.0)}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
              title="Step forward 1.0s"
            >
              <FastForward className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => handleStep(-currentTime)}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
              title="Reset to 00:00"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Center: Timestamp Display */}
          <div className="font-mono text-slate-300 text-xs bg-slate-900 border border-slate-800 px-3 py-1 rounded-lg shadow-inner">
            <span className="text-cyan-400 font-semibold">{formatTime(currentTime)}</span>
            <span className="text-slate-600 mx-1.5">/</span>
            <span className="text-slate-400">{formatTime(duration)}</span>
          </div>

          {/* Right: Speed controls & audio */}
          <div className="flex items-center gap-2">
            {/* Speed pills */}
            <div className="flex items-center bg-slate-900 rounded-lg p-0.5 border border-slate-800 text-[11px] font-mono">
              <span className="px-1 text-slate-500">
                <Gauge className="w-3 h-3" />
              </span>
              {[0.5, 1.0, 1.5, 2.0].map((rate) => (
                <button
                  key={rate}
                  type="button"
                  onClick={() => setPlaybackSpeed(rate)}
                  className={`px-1.5 py-0.5 rounded ${
                    playbackSpeed === rate
                      ? 'bg-cyan-500/20 text-cyan-300 font-bold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {rate}x
                </button>
              ))}
            </div>

            {/* Audio toggle */}
            <button
              type="button"
              onClick={() => setIsMuted(!isMuted)}
              className={`p-1.5 rounded-lg border transition-colors ${
                isMuted
                  ? 'bg-slate-800 border-slate-700 text-slate-400'
                  : 'bg-cyan-900/40 border-cyan-600 text-cyan-300'
              }`}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VideoPlayer;

