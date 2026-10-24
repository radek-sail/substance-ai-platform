import React, { useState } from 'react';
import {
  Boxes,
  FlaskConical,
  Video,
  Database,
  Building,
  User,
  CheckCircle2,
  AlertCircle,
  FileCheck2,
  Sliders,
  Sparkles,
} from 'lucide-react';
import { TenantConfig } from '../../services/api.service';

export type WorkflowTab = 'inventory' | 'archive' | 'videos';

interface RibbonNavProps {
  activeTab: WorkflowTab;
  onSelectTab: (tab: WorkflowTab) => void;
  tenant: TenantConfig;
  onUpdateTenant: (tenant: Partial<TenantConfig>) => void;
  isSignedOff?: boolean;
  onOpenSignOffModal?: () => void;
  videoTitle?: string;
}

export const RibbonNav: React.FC<RibbonNavProps> = ({
  activeTab,
  onSelectTab,
  tenant,
  onUpdateTenant,
  isSignedOff = false,
  onOpenSignOffModal,
  videoTitle = 'vid_cryo_demo_01.mp4',
}) => {
  const [showTenantModal, setShowTenantModal] = useState(false);
  const [tempCustomer, setTempCustomer] = useState(tenant.customerId);
  const [tempDatabase, setTempDatabase] = useState(tenant.databaseId);
  const [tempOperator, setTempOperator] = useState(tenant.operatorInitials || 'RS');

  const handleSaveTenant = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateTenant({
      customerId: tempCustomer.trim(),
      databaseId: tempDatabase.trim(),
      operatorInitials: tempOperator.trim().toUpperCase(),
    });
    setShowTenantModal(false);
  };

  return (
    <>
      <header className="bg-slate-900/90 backdrop-blur-md border-b border-slate-800 sticky top-0 z-40 select-none shadow-lg shadow-black/40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16 gap-4">
            {/* SAIL Brand */}
            <div className="flex items-center gap-3 shrink-0">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600 via-indigo-600 to-emerald-500 p-0.5 shadow-md shadow-cyan-500/20">
                <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-cyan-400 animate-pulse" />
                </div>
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-lg tracking-wider bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 via-indigo-300 to-emerald-400 font-mono">
                    SAIL
                  </span>
                  <span className="text-xs uppercase tracking-widest text-slate-500 font-semibold">
                    v1.0 HITL
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 hidden sm:block">
                  Substance AI Lab Automation
                </div>
              </div>
            </div>

            {/* Navigation Ribbon Tabs */}
            <nav className="flex items-center bg-slate-950/80 p-1 rounded-xl border border-slate-800/80 shadow-inner">
              <button
                type="button"
                onClick={() => onSelectTab('inventory')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 ${
                  activeTab === 'inventory'
                    ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-md shadow-cyan-500/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
                title="Cell Line Cryo-Inventory Manager"
              >
                <Boxes className="w-4 h-4" />
                <span>🧊 Cryo-Inventory</span>
              </button>

              <button
                type="button"
                onClick={() => onSelectTab('archive')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 ${
                  activeTab === 'archive'
                    ? 'bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-md shadow-emerald-500/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
                title="Experiment Archive Manager"
              >
                <FlaskConical className="w-4 h-4" />
                <span>🧪 Experiment Archive</span>
              </button>

              <button
                type="button"
                onClick={() => onSelectTab('videos')}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 ${
                  activeTab === 'videos'
                    ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-md shadow-indigo-500/25'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
                title="Video Manager & Ingestion"
              >
                <Video className="w-4 h-4" />
                <span>📹 Video Manager</span>
              </button>
            </nav>

            {/* Tenant Context & Sign-Off Action */}
            <div className="flex items-center gap-3">
              {/* Tenant context pill button */}
              <button
                type="button"
                onClick={() => setShowTenantModal(true)}
                className="flex items-center gap-2 bg-slate-800/60 hover:bg-slate-800 border border-slate-700/60 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 transition-colors"
                title="Click to edit tenant configuration"
              >
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                <div className="flex items-center gap-1.5 font-mono text-[11px]">
                  <span className="text-slate-400">{tenant.customerId}</span>
                  <span className="text-slate-600">/</span>
                  <span className="text-cyan-400">{tenant.databaseId}</span>
                </div>
                <span className="bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded text-[10px] font-bold">
                  {tenant.operatorInitials || 'OP'}
                </span>
                <Sliders className="w-3 h-3 text-slate-400 ml-0.5" />
              </button>

              {/* Sign-off status & commit trigger */}
              {isSignedOff ? (
                <div className="flex items-center gap-1.5 bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 px-3 py-1.5 rounded-lg text-xs font-medium shadow-sm shadow-emerald-950">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>Signed Off</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onOpenSignOffModal}
                  className="flex items-center gap-2 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold shadow-md shadow-orange-500/20 active:scale-95 transition-all"
                >
                  <FileCheck2 className="w-4 h-4" />
                  <span>Review & Sign Off</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Sub-banner showing active record / video title */}
        <div className="bg-slate-950/70 border-t border-slate-800/50 px-4 py-1 flex items-center justify-between text-[11px] text-slate-400 font-mono">
          <div className="flex items-center gap-2">
            <span className="text-slate-500">ACTIVE STREAM:</span>
            <span className="text-slate-200">{videoTitle}</span>
          </div>
          <div className="flex items-center gap-3 text-slate-400">
            <span>Passes: 0 (Audio) • 1 (Action) • 2 (Event) • 3 (Refinement)</span>
            <span className="text-slate-600">|</span>
            <span className="text-emerald-400">ISO-9001 Compliant</span>
          </div>
        </div>
      </header>

      {/* Tenant Context Configuration Modal */}
      {showTenantModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 w-full max-w-md shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-4">
              <div className="flex items-center gap-2 text-cyan-400 font-semibold text-base">
                <Sliders className="w-5 h-5" />
                <span>Tenant Scoping Context</span>
              </div>
              <button
                type="button"
                onClick={() => setShowTenantModal(false)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveTenant} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-400 font-medium mb-1 flex items-center gap-1.5">
                  <Building className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Customer Identifier (`x-customer-id`):</span>
                </label>
                <input
                  type="text"
                  value={tempCustomer}
                  onChange={(e) => setTempCustomer(e.target.value)}
                  placeholder="e.g. customer-alpha"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                  required
                />
                <p className="text-[10px] text-slate-500 mt-1">
                  Scopes Cloud Storage bucket: <code>gs://&#123;customerId&#125;-video-manager-storage/</code>
                </p>
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Firestore Database ID (`x-database-id`):</span>
                </label>
                <input
                  type="text"
                  value={tempDatabase}
                  onChange={(e) => setTempDatabase(e.target.value)}
                  placeholder="e.g. customer-alpha-db"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
                  required
                />
                <p className="text-[10px] text-slate-500 mt-1">
                  Scopes Firestore path: <code>/databases/&#123;databaseId&#125;/documents/</code>
                </p>
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1 flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Operator Initials / Signature:</span>
                </label>
                <input
                  type="text"
                  maxLength={4}
                  value={tempOperator}
                  onChange={(e) => setTempOperator(e.target.value.toUpperCase())}
                  placeholder="e.g. RS"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 font-mono uppercase focus:outline-none focus:border-cyan-500"
                  required
                />
              </div>

              <div className="pt-4 flex justify-end gap-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowTenantModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium shadow-md shadow-cyan-600/30"
                >
                  Save Context
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

export default RibbonNav;

