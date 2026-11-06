import React, { useState } from 'react';
import {
  BookOpen,
  Plus,
  X,
  CheckCircle2,
  Loader2,
  User,
  Calendar,
  FlaskConical,
  ListChecks,
  Eraser,
  Trash2,
} from 'lucide-react';
import type { ArchiveRecord, CreateArchiveInput } from '@sail/shared';

interface ArchiveSidebarProps {
  archives: ArchiveRecord[];
  activeArchiveId: string | null;
  isLoading: boolean;
  onSelectArchive: (id: string) => void;
  onCreateArchive: (payload: CreateArchiveInput) => Promise<void>;
  onEmptyArchive?: (id: string) => Promise<void> | void;
  onDeleteArchive?: (id: string) => Promise<void> | void;
}

export const ArchiveSidebar: React.FC<ArchiveSidebarProps> = ({
  archives,
  activeArchiveId,
  isLoading,
  onSelectArchive,
  onCreateArchive,
  onEmptyArchive,
  onDeleteArchive,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [emptyingId, setEmptyingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form State for Add Archive
  const [name, setName] = useState('');
  const [creatorName, setCreatorName] = useState('');
  const [creationDate, setCreationDate] = useState<string>(
    new Date().toISOString().split('T')[0]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Archive name is required');
      return;
    }

    setIsCreating(true);
    try {
      await onCreateArchive({
        name: name.trim(),
        creatorName: creatorName.trim() || 'N/A',
        creationDate: creationDate.trim() || new Date().toISOString().split('T')[0],
      });
      setIsModalOpen(false);
      setName('');
      setCreatorName('');
      setCreationDate(new Date().toISOString().split('T')[0]);
    } catch (err: any) {
      setError(err?.message || 'Failed to create archive');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div
      data-testid="archive-sidebar"
      className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col gap-4 shadow-xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-indigo-950 border border-indigo-800 text-indigo-400">
            <BookOpen className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 font-mono">Experiment Archives</h3>
            <p className="text-[11px] text-slate-400">Lab Notebooks & Runs</p>
          </div>
        </div>
        <button
          type="button"
          data-testid="add-archive-btn"
          onClick={() => {
            setError(null);
            setIsModalOpen(true);
          }}
          className="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors shadow-sm"
          title="Add New Experiment Archive"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add</span>
        </button>
      </div>

      {/* Archive List */}
      <div className="flex flex-col gap-2 max-h-[640px] overflow-y-auto pr-1">
        {isLoading && archives.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-6 text-slate-400 gap-2">
            <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
            <span className="text-xs font-mono">Loading archives...</span>
          </div>
        ) : archives.length === 0 ? (
          <div className="text-center p-6 border border-dashed border-slate-800 rounded-xl text-slate-400">
            <p className="text-xs">No experiment archives registered.</p>
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="mt-2 text-xs text-indigo-400 hover:underline font-mono"
            >
              + Create First Archive
            </button>
          </div>
        ) : (
          archives.map((arch) => {
            const isSelected = arch.id === activeArchiveId;
            const reagentCount = arch.reagents?.length ?? 0;
            const stepCount = arch.workSteps?.length ?? 0;
            const displayDate =
              arch.creationDate ||
              (arch.createdAt ? arch.createdAt.split('T')[0] : 'N/A');
            const displayOwner = arch.creatorName || 'N/A';
            const isEmptyingThis = emptyingId === arch.id;
            const isDeletingThis = deletingId === arch.id;

            return (
              <div
                key={arch.id}
                role="button"
                tabIndex={0}
                data-testid={`archive-item-${arch.id}`}
                onClick={() => onSelectArchive(arch.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectArchive(arch.id);
                  }
                }}
                className={`w-full text-left p-3 rounded-xl border transition-all duration-150 flex flex-col gap-1.5 relative cursor-pointer ${
                  isSelected
                    ? 'bg-indigo-950/40 border-indigo-500 text-indigo-100 shadow-lg shadow-indigo-950/40 ring-1 ring-indigo-500/40'
                    : 'bg-slate-950/60 border-slate-800/80 text-slate-300 hover:border-slate-700 hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-start justify-between gap-1.5">
                  <span className="text-xs font-bold font-mono truncate">{arch.name}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    {onEmptyArchive && (
                      <button
                        type="button"
                        disabled={isEmptyingThis || isDeletingThis}
                        data-testid={`erase-archive-btn-${arch.id}`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          setEmptyingId(arch.id);
                          try {
                            await onEmptyArchive(arch.id);
                          } finally {
                            setEmptyingId(null);
                          }
                        }}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono font-semibold bg-amber-950/70 hover:bg-amber-900/80 text-amber-300 border border-amber-700/60 transition-colors disabled:opacity-50"
                        title={`Erase notebook content of ${arch.name}`}
                      >
                        {isEmptyingThis ? (
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        ) : (
                          <Eraser className="w-2.5 h-2.5" />
                        )}
                        <span>erase</span>
                      </button>
                    )}
                    {onDeleteArchive && (
                      <button
                        type="button"
                        disabled={isDeletingThis || isEmptyingThis}
                        data-testid={`delete-archive-btn-${arch.id}`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          setDeletingId(arch.id);
                          try {
                            await onDeleteArchive(arch.id);
                          } finally {
                            setDeletingId(null);
                          }
                        }}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono font-semibold bg-rose-950/70 hover:bg-rose-900/80 text-rose-300 border border-rose-700/60 transition-colors disabled:opacity-50"
                        title={`Delete archive ${arch.name}`}
                      >
                        {isDeletingThis ? (
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-2.5 h-2.5" />
                        )}
                        <span>delete</span>
                      </button>
                    )}
                    {isSelected && (
                      <span className="shrink-0 p-0.5 rounded-full bg-indigo-400/20 text-indigo-300">
                        <CheckCircle2 className="w-3.5 h-3.5 text-indigo-400" />
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-[11px] font-mono text-slate-400 flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2 text-slate-300">
                    <span className="inline-flex items-center gap-1 truncate">
                      <User className="w-3 h-3 text-indigo-400 shrink-0" />
                      <span className="truncate">{displayOwner}</span>
                    </span>
                    <span className="inline-flex items-center gap-1 text-slate-400 shrink-0">
                      <Calendar className="w-3 h-3 text-slate-500 shrink-0" />
                      <span>{displayDate}</span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-400 pt-0.5">
                    <span className="inline-flex items-center gap-1">
                      <FlaskConical className="w-3 h-3 text-cyan-400" />
                      <span>{reagentCount} reagent{reagentCount === 1 ? '' : 's'}</span>
                    </span>
                    <span className="inline-flex items-center gap-1 text-slate-500">
                      <ListChecks className="w-3 h-3 text-emerald-400" />
                      <span>{stepCount} step{stepCount === 1 ? '' : 's'}</span>
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Add Archive Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/50">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-indigo-950 border border-indigo-800 text-indigo-400">
                  <BookOpen className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-slate-100 font-mono">
                    Add New Experiment Archive
                  </h4>
                  <p className="text-[11px] text-slate-400">
                    Initialize an Experiment Notebook record
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 p-1 rounded-lg hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              {error && (
                <div className="p-2.5 rounded-lg bg-rose-950/60 border border-rose-500/60 text-rose-200 text-xs font-mono">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">
                  Archive Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Exp-2026-04B Cell Culture & Plate Seeding"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">
                    Archive Owner
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Dr. Elena Vance"
                    value={creatorName}
                    onChange={(e) => setCreatorName(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">
                    Date Created On
                  </label>
                  <input
                    type="date"
                    value={creationDate}
                    onChange={(e) => setCreationDate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs font-semibold text-slate-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreating}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {isCreating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{isCreating ? 'Creating...' : 'Create Archive'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ArchiveSidebar;
