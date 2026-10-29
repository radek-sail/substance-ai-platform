import React, { useEffect, useState } from 'react';
import { BoxGridView } from './BoxGridView';
import { VialInspector, type HumanEditedVialData } from './VialInspector';
import { apiService, type TenantConfig } from '../../services/api.service';
import type { Action, Event, Refinement, VideoAnalysisDoc } from '@sail/shared';

export interface CryoInventoryProps {
  activeStream: string;
  tenant: TenantConfig;
  analysis: VideoAnalysisDoc | null;
  selectedAction?: Action;
  events: Event[];
  refinements: Refinement[];
  targetRow: string;
  targetCol: number;
  rawTargetRow: string;
  rawTargetCol: number;
  editedInventoryData: HumanEditedVialData;
  rawAiInventoryData: HumanEditedVialData;
  isSignedOff: boolean;
  onSelectGridSlot: (row: string, col: number) => void;
  onChangeField: (field: keyof HumanEditedVialData, value: any) => void;
  onResetField: (field: keyof HumanEditedVialData) => void;
  onAnalysisLoaded?: (videoId: string, doc: VideoAnalysisDoc) => void;
}

export const CryoInventory: React.FC<CryoInventoryProps> = ({
  activeStream,
  tenant,
  analysis,
  selectedAction,
  events,
  refinements,
  targetRow,
  targetCol,
  rawTargetRow,
  rawTargetCol,
  editedInventoryData,
  rawAiInventoryData,
  isSignedOff,
  onSelectGridSlot,
  onChangeField,
  onResetField,
  onAnalysisLoaded,
}) => {
  const [verifiedStreamId, setVerifiedStreamId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const isDemoStream =
      !activeStream ||
      activeStream === 'vid_cryo_demo_01' ||
      activeStream === 'vid_archive_demo_02';

    if (isDemoStream) {
      setVerifiedStreamId(activeStream);
      return;
    }

    // When Pass 2 or Pass 3 has completed for the activeStream, ensure inventory data
    // is loaded directly from Firestore `video_analyses/{activeStream}` rather than mock data.
    const verifyAndLoadActiveStreamAnalysis = async () => {
      try {
        const passRes = await apiService.fetchVideoPasses(activeStream, {
          customerId: tenant.customerId,
          databaseId: tenant.databaseId,
        });
        const pass2Done = passRes.passes?.pass2?.status === 'COMPLETED';
        const pass3Done = passRes.passes?.pass3?.status === 'COMPLETED';

        if (
          (pass2Done || pass3Done || passRes.status === 'ANALYSIS_COMPLETE') &&
          (!analysis || analysis.videoId !== activeStream || verifiedStreamId !== activeStream)
        ) {
          const doc = await apiService.fetchVideoAnalysis(activeStream, {
            customerId: tenant.customerId,
            databaseId: tenant.databaseId,
          });
          if (!cancelled && doc && doc.videoId === activeStream) {
            setVerifiedStreamId(activeStream);
            onAnalysisLoaded?.(activeStream, doc);
          }
        }
      } catch {
        // Fallback: attempt direct fetch of `video_analyses/{activeStream}` if not yet matched
        if (!analysis || analysis.videoId !== activeStream) {
          try {
            const doc = await apiService.fetchVideoAnalysis(activeStream, {
              customerId: tenant.customerId,
              databaseId: tenant.databaseId,
            });
            if (!cancelled && doc && doc.videoId === activeStream) {
              setVerifiedStreamId(activeStream);
              onAnalysisLoaded?.(activeStream, doc);
            }
          } catch {
            // Stream has not completed Pass 2 / Pass 3 yet
          }
        }
      }
    };

    verifyAndLoadActiveStreamAnalysis();

    return () => {
      cancelled = true;
    };
  }, [activeStream, tenant.customerId, tenant.databaseId]);

  const boxId =
    selectedAction?.inventoryId ||
    analysis?.workflowClassification?.inventoryName ||
    analysis?.workloadClassification?.inventoryName ||
    'CryoBox_Tower02_B03';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Cryo-Box N x M Interactive Grid View */}
      <div className="lg:col-span-6">
        <BoxGridView
          rows={9}
          cols={9}
          boxId={boxId}
          targetRow={targetRow}
          targetCol={targetCol}
          differencedRow={rawTargetRow}
          differencedCol={rawTargetCol}
          onSelectSlot={onSelectGridSlot}
          readOnly={isSignedOff}
        />
      </div>

      {/* Multi-Pass Extraction Vial Inspector */}
      <div className="lg:col-span-6">
        <VialInspector
          action={selectedAction}
          events={events}
          refinements={refinements}
          editedData={editedInventoryData}
          rawAiData={rawAiInventoryData}
          onChange={onChangeField}
          onResetField={onResetField}
          readOnly={isSignedOff}
        />
      </div>
    </div>
  );
};

export default CryoInventory;
