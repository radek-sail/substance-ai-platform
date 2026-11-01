import React, { useState } from 'react';
import {
  Boxes,
  Plus,
  X,
  Server,
  Layers,
  CheckCircle2,
  ChevronRight,
  Database,
  Loader2,
} from 'lucide-react';
import type { InventoryRecord, CreateInventoryInput } from '@sail/shared';

interface InventorySidebarProps {
  inventories: InventoryRecord[];
  activeInventoryId: string | null;
  isLoading: boolean;
  onSelectInventory: (id: string) => void;
  onCreateInventory: (payload: CreateInventoryInput) => Promise<void>;
}

export const InventorySidebar: React.FC<InventorySidebarProps> = ({
  inventories,
  activeInventoryId,
  isLoading,
  onSelectInventory,
  onCreateInventory,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form State for Add Inventory
  const [name, setName] = useState('');
  const [towersCount, setTowersCount] = useState<number>(4);
  const [boxesPerTower, setBoxesPerTower] = useState<number>(5);
  const [rowsPerBox, setRowsPerBox] = useState<number>(9);
  const [colsPerBox, setColsPerBox] = useState<number>(9);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Inventory name is required');
      return;
    }

    if (towersCount < 1 || towersCount > 26) {
      setError('Towers count must be between 1 and 26 (Towers A–Z)');
      return;
    }

    if (boxesPerTower < 1 || rowsPerBox < 1 || colsPerBox < 1) {
      setError('Boxes per tower, rows, and columns must be at least 1');
      return;
    }

    setIsCreating(true);
    try {
      await onCreateInventory({
        name: name.trim(),
        towersCount,
        boxesPerTower,
        rowsPerBox,
        colsPerBox,
      });
      setIsModalOpen(false);
      setName('');
      setTowersCount(4);
      setBoxesPerTower(5);
      setRowsPerBox(9);
      setColsPerBox(9);
    } catch (err: any) {
      setError(err?.message || 'Failed to create inventory');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col gap-4 shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-cyan-950 border border-cyan-800 text-cyan-400">
            <Boxes className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 font-mono">Cryo Inventories</h3>
            <p className="text-[11px] text-slate-400">Multi-Tank Storage Units</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setIsModalOpen(true);
          }}
          className="flex items-center gap-1 bg-cyan-600 hover:bg-cyan-500 text-white px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors shadow-sm"
          title="Add New Inventory"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add</span>
        </button>
      </div>

      {/* Inventory List */}
      <div className="flex flex-col gap-2 max-h-[640px] overflow-y-auto pr-1">
        {isLoading && inventories.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-6 text-slate-400 gap-2">
            <Loader2 className="w-5 h-5 text-cyan-400 animate-spin" />
            <span className="text-xs font-mono">Loading inventories...</span>
          </div>
        ) : inventories.length === 0 ? (
          <div className="text-center p-6 border border-dashed border-slate-800 rounded-xl text-slate-400">
            <p className="text-xs">No inventories registered.</p>
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="mt-2 text-xs text-cyan-400 hover:underline font-mono"
            >
              + Create First Inventory
            </button>
          </div>
        ) : (
          inventories.map((inv) => {
            const isSelected = inv.id === activeInventoryId;
            const endTowerLetter = String.fromCharCode(64 + inv.towersCount);
            const totalBoxes = inv.towersCount * inv.boxesPerTower;

            return (
              <button
                key={inv.id}
                type="button"
                onClick={() => onSelectInventory(inv.id)}
                className={`w-full text-left p-3 rounded-xl border transition-all duration-150 flex flex-col gap-1.5 relative ${
                  isSelected
                    ? 'bg-cyan-950/40 border-cyan-500 text-cyan-100 shadow-lg shadow-cyan-950/40 ring-1 ring-cyan-500/40'
                    : 'bg-slate-950/60 border-slate-800/80 text-slate-300 hover:border-slate-700 hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-start justify-between gap-1">
                  <span className="text-xs font-bold font-mono truncate">{inv.name}</span>
                  {isSelected && (
                    <span className="shrink-0 p-0.5 rounded-full bg-cyan-400/20 text-cyan-300">
                      <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" />
                    </span>
                  )}
                </div>

                <div className="text-[11px] font-mono text-slate-400 flex flex-col gap-0.5">
                  <div className="flex items-center gap-1 text-slate-300">
                    <Layers className="w-3 h-3 text-cyan-400 shrink-0" />
                    <span>
                      Towers A–{endTowerLetter} ({inv.towersCount}) · {inv.boxesPerTower} boxes/tower
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-400 pt-0.5">
                    <span>Grid: {inv.rowsPerBox}×{inv.colsPerBox}</span>
                    <span className="text-slate-500">{totalBoxes} total boxes</span>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Add Inventory Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-950/50">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-cyan-950 border border-cyan-800 text-cyan-400">
                  <Server className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-slate-100 font-mono">
                    Add New Cryo Inventory
                  </h4>
                  <p className="text-[11px] text-slate-400">Configure tank rack and box architecture</p>
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
                  Inventory Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Cryo Tank Delta - Oncology Bank"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">
                    Number of Towers (1–26)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="26"
                    required
                    value={towersCount}
                    onChange={(e) => setTowersCount(parseInt(e.target.value, 10) || 1)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                  />
                  <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">
                    Labeled A through {String.fromCharCode(64 + Math.min(26, Math.max(1, towersCount)))}
                  </span>
                </div>
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">
                    Boxes Per Tower
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    required
                    value={boxesPerTower}
                    onChange={(e) => setBoxesPerTower(parseInt(e.target.value, 10) || 1)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                  />
                  <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">
                    Numbered 1 through {boxesPerTower}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">
                    Rows in Box
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="26"
                    required
                    value={rowsPerBox}
                    onChange={(e) => setRowsPerBox(parseInt(e.target.value, 10) || 1)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                  />
                  <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">
                    Standard 9 for 81-slot
                  </span>
                </div>
                <div>
                  <label className="block text-xs font-mono text-slate-300 mb-1">
                    Columns in Box
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="26"
                    required
                    value={colsPerBox}
                    onChange={(e) => setColsPerBox(parseInt(e.target.value, 10) || 1)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                  />
                  <span className="text-[10px] text-slate-500 font-mono mt-0.5 block">
                    Standard 9 for 81-slot
                  </span>
                </div>
              </div>

              <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800 text-[11px] font-mono text-slate-400 space-y-1">
                <div className="flex justify-between">
                  <span>Total Boxes to generate:</span>
                  <strong className="text-cyan-300">{towersCount * boxesPerTower}</strong>
                </div>
                <div className="flex justify-between">
                  <span>Total Slots across inventory:</span>
                  <strong className="text-cyan-300">
                    {towersCount * boxesPerTower * rowsPerBox * colsPerBox}
                  </strong>
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
                  className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                  {isCreating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{isCreating ? 'Creating...' : 'Create Inventory'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default InventorySidebar;
