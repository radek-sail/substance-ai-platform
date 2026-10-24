import React, { useState } from 'react';
import {
  FileText,
  Eye,
  Code,
  Sparkles,
  FlaskConical,
  Plus,
  Check,
  BookOpen,
} from 'lucide-react';

export interface ReagentMapping {
  acronym: string;
  fullName: string;
  volume: string;
  concentration?: string;
}

interface NotebookEditorProps {
  markdownDoc: string;
  onChangeMarkdown: (newDoc: string) => void;
  reagentMappings?: ReagentMapping[];
  readOnly?: boolean;
}

export const DEFAULT_REAGENTS: ReagentMapping[] = [
  {
    acronym: 'DMEM',
    fullName: "Dulbecco's Modified Eagle Medium",
    volume: '450 mL',
    concentration: '1x Basal',
  },
  {
    acronym: 'FBS',
    fullName: 'Fetal Bovine Serum',
    volume: '50 mL',
    concentration: '10% v/v',
  },
  {
    acronym: 'P/S',
    fullName: 'Penicillin-Streptomycin',
    volume: '5 mL',
    concentration: '1% v/v (100 U/mL)',
  },
  {
    acronym: 'PBS',
    fullName: 'Phosphate-Buffered Saline (1X, pH 7.4)',
    volume: '10 mL',
    concentration: '1x Wash Buffer',
  },
];

export const DEFAULT_EXPERIMENT_MARKDOWN = `## Description
Automated high-throughput cell seeding and media reconstitution protocol for 96-well microplate screening. Reconstituted complete growth medium under sterile laminar flow hood and seeded HEK293T cells across columns 1 through 6 using an 8-channel precision pipette.

## Reagents Used
- **DMEM** (Dulbecco's Modified Eagle Medium): 450 mL
- **FBS** (Fetal Bovine Serum): 50 mL (10% final concentration)
- **P/S** (Penicillin-Streptomycin): 5 mL (1% final concentration)
- **Cell Stock**: HEK293T (Passage 5, Viability 98.2%)

## Experiment Steps
1. **Pass 0 & 1 Verification**: Authenticated operator instructions and confirmed sterile environment protocol.
2. **Reconstitution**: Aseptically added 50 mL FBS and 5 mL P/S into 450 mL DMEM basal medium bottle and inverted gently 5 times.
3. **Plate Preparation**: Loaded sterile 96-well clear-bottom microplate into biosafety cabinet.
4. **8-Way Multichannel Seeding**: Aspirated 100 µL reconstituted cell suspension per channel and seeded into Columns 1 to 6 (Wells A1 through H6).
5. **Incubation & QC**: Transferred seeded plate to incubator (37°C, 5% CO2).
`;

export const NotebookEditor: React.FC<NotebookEditorProps> = ({
  markdownDoc,
  onChangeMarkdown,
  reagentMappings = DEFAULT_REAGENTS,
  readOnly = false,
}) => {
  const [activeTab, setActiveTab] = useState<'editor' | 'preview' | 'split'>('split');
  const [copiedAcronym, setCopiedAcronym] = useState<string | null>(null);

  const handleInsertAcronym = (item: ReagentMapping) => {
    if (readOnly) return;
    const snippet = `- **${item.acronym}** (${item.fullName}): ${item.volume} (${item.concentration || ''})\n`;
    onChangeMarkdown(markdownDoc + '\n' + snippet);
    setCopiedAcronym(item.acronym);
    setTimeout(() => setCopiedAcronym(null), 1500);
  };

  // Lightweight live markdown renderer
  const renderSimpleMarkdown = (md: string) => {
    const lines = md.split('\n');
    return (
      <div className="space-y-3 text-slate-200 text-xs font-sans leading-relaxed">
        {lines.map((line, idx) => {
          if (line.startsWith('## ')) {
            return (
              <h2
                key={idx}
                className="text-sm font-bold text-cyan-400 border-b border-slate-800 pb-1 mt-4 first:mt-0 font-mono flex items-center gap-2"
              >
                <span>{line.replace('## ', '')}</span>
              </h2>
            );
          }
          if (line.startsWith('- ')) {
            return (
              <li key={idx} className="ml-4 list-disc text-slate-300">
                {line.replace('- ', '')}
              </li>
            );
          }
          if (line.match(/^\d+\.\s/)) {
            return (
              <li key={idx} className="ml-4 list-decimal text-slate-300">
                {line.replace(/^\d+\.\s/, '')}
              </li>
            );
          }
          if (line.trim() === '') {
            return <div key={idx} className="h-1" />;
          }
          return (
            <p key={idx} className="text-slate-300">
              {line}
            </p>
          );
        })}
      </div>
    );
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-teal-950 border border-teal-800 text-teal-400">
            <BookOpen className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2 font-mono">
              <span>EXPERIMENT NOTEBOOK & REAGENT RESOLVER</span>
            </h3>
            <p className="text-[11px] text-slate-400">
              AI-compiled electronic lab notebook (ELN) markdown document
            </p>
          </div>
        </div>

        {/* View mode toggle */}
        <div className="flex items-center bg-slate-950 rounded-lg p-0.5 border border-slate-800 text-xs">
          <button
            type="button"
            onClick={() => setActiveTab('editor')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors ${
              activeTab === 'editor'
                ? 'bg-cyan-600 text-white font-medium'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Code className="w-3.5 h-3.5" />
            <span>Source</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('split')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors ${
              activeTab === 'split'
                ? 'bg-cyan-600 text-white font-medium'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Split</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('preview')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors ${
              activeTab === 'preview'
                ? 'bg-cyan-600 text-white font-medium'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>Preview</span>
          </button>
        </div>
      </div>

      {/* Reagent Acronym Resolution Mapping Track */}
      <div>
        <div className="flex items-center justify-between text-xs font-semibold text-slate-300 mb-2">
          <span className="flex items-center gap-1.5">
            <FlaskConical className="w-3.5 h-3.5 text-teal-400" />
            <span>Pass 3 Reagent Acronym Mapper & Pipetted Volumes</span>
          </span>
          <span className="text-[10px] text-slate-500 font-mono">
            {reagentMappings.length} Acronyms Conflated
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {reagentMappings.map((reagent) => (
            <div
              key={reagent.acronym}
              className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 hover:border-teal-500/60 transition-all flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono font-bold text-teal-300 text-xs bg-teal-950 px-1.5 py-0.5 rounded border border-teal-800/80">
                    {reagent.acronym}
                  </span>
                  <span className="font-mono text-[11px] text-cyan-400 font-medium">
                    {reagent.volume}
                  </span>
                </div>
                <div className="text-[11px] text-slate-300 line-clamp-1 font-medium" title={reagent.fullName}>
                  {reagent.fullName}
                </div>
                {reagent.concentration && (
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    {reagent.concentration}
                  </div>
                )}
              </div>

              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleInsertAcronym(reagent)}
                  className="mt-2 text-[10px] font-mono flex items-center justify-center gap-1 bg-slate-900 hover:bg-slate-800 text-slate-300 py-1 rounded border border-slate-700/60 transition-colors"
                >
                  {copiedAcronym === reagent.acronym ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400">Appended</span>
                    </>
                  ) : (
                    <>
                      <Plus className="w-3 h-3 text-cyan-400" />
                      <span>Append to Note</span>
                    </>
                  )}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Editor & Preview Area */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Source Markdown Editor */}
        {(activeTab === 'editor' || activeTab === 'split') && (
          <div
            className={`flex flex-col bg-slate-950 rounded-xl border border-slate-800 overflow-hidden ${
              activeTab === 'editor' ? 'lg:col-span-2' : ''
            }`}
          >
            <div className="bg-slate-900/80 px-3 py-1.5 border-b border-slate-800 text-[11px] font-mono text-slate-400 flex items-center justify-between">
              <span>MARKDOWN SOURCE</span>
              <span className="text-slate-500">{markdownDoc.length} chars</span>
            </div>
            <textarea
              disabled={readOnly}
              value={markdownDoc}
              onChange={(e) => onChangeMarkdown(e.target.value)}
              rows={14}
              className="w-full h-full p-4 bg-transparent font-mono text-xs text-slate-200 focus:outline-none resize-none selection:bg-cyan-500/40"
              placeholder="Write experiment description, reagents, and steps in Markdown..."
            />
          </div>
        )}

        {/* Live Compiled Preview */}
        {(activeTab === 'preview' || activeTab === 'split') && (
          <div
            className={`flex flex-col bg-slate-950 rounded-xl border border-slate-800 overflow-hidden ${
              activeTab === 'preview' ? 'lg:col-span-2' : ''
            }`}
          >
            <div className="bg-slate-900/80 px-3 py-1.5 border-b border-slate-800 text-[11px] font-mono text-slate-400 flex items-center justify-between">
              <span>LIVE COMPILED PREVIEW</span>
              <span className="text-emerald-400 flex items-center gap-1">
                <Sparkles className="w-3 h-3" />
                <span>Format Verified</span>
              </span>
            </div>
            <div className="p-4 overflow-y-auto max-h-[380px]">
              {renderSimpleMarkdown(markdownDoc)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default NotebookEditor;

