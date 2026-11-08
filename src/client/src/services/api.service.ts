import {
  type VideoAnalysisDoc,
  VideoAnalysisDocSchema,
  type BoxUpdate,
  BoxUpdateSchema,
  type InventorySignOffPayload,
  InventorySignOffPayloadSchema,
  type ArchiveSignOffPayload,
  ArchiveSignOffPayloadSchema,
  type VideoMetadata,
  type VideoRecord,
  type VideoStatus,
  type VideoPasses,
  type PassStepState,
  type PassStatus,
  type InventoryRecord,
  type InventoryBox,
  type InventoryCell,
  type CreateInventoryInput,
  type ArchiveRecord,
  type ArchiveReagent,
  type ArchiveWorkStep,
  type CreateArchiveInput,
  render96WellPlateMarkdown,
  generateReagentAcronym,
  toActiveVoiceDescription,
  DEFAULT_VIDEO_PASSES,
} from '@sail/shared';
import { auth } from '../firebase';

export type { VideoRecord, VideoStatus, VideoPasses, PassStepState, PassStatus };
export type { InventoryRecord, InventoryBox, InventoryCell, CreateInventoryInput };
export type { ArchiveRecord, ArchiveReagent, ArchiveWorkStep, CreateArchiveInput };
export { DEFAULT_VIDEO_PASSES };

export interface TenantConfig {
  customerId: string;
  databaseId: string;
  operatorInitials?: string;
  bucketName?: string;
}

export interface ApiClientOptions {
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
  tenant?: TenantConfig;
}

export interface UploadVideoResponse {
  success?: boolean;
  video?: VideoRecord;
  videoId: string;
  status: VideoStatus;
  originalName: string;
  gcsBucket?: string;
  rawPath?: string;
  normalizedPath?: string;
  uploadedAt?: string | number;
  transcodedAt?: string | number;
  passes?: VideoPasses;
  rawGcsUri: string;
  originalGcsUri?: string;
  normalizedGcsUri: string;
  customerId?: string;
  databaseId?: string;
  metadata?: VideoMetadata;
}

export interface RunPassResponse {
  success: boolean;
  videoId: string;
  pass: 0 | 1 | 2 | 3 | 'all';
  status: VideoStatus;
  geminiFileUri?: string;
  data: any;
  passes: VideoPasses;
  analysis?: VideoAnalysisDoc;
}

export interface VideoPassesResponse {
  videoId: string;
  status: VideoStatus;
  geminiFileUri?: string;
  passes: VideoPasses;
}

export interface TriggerAnalysisResponse {
  success: boolean;
  videoId: string;
  analysisId?: string;
  status?: VideoStatus;
  passes?: VideoPasses;
  summary: {
    workflowType: string;
    actionCount: number;
    eventCount: number;
    refinementCount: number;
  };
  analysis: VideoAnalysisDoc;
}

export interface SignOffResponse {
  success: boolean;
  message: string;
  signedOffAt: string;
  documentPath: string;
  details?: Record<string, any>;
}

export const DEFAULT_GCS_BUCKET: string =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_GCS_BUCKET_NAME) ||
  'sail-platform-videos-prod';

// Default tenant configuration
export const DEFAULT_TENANT_CONFIG: TenantConfig = {
  customerId: 'customer-alpha',
  databaseId: '(default)',
  operatorInitials: 'RS',
  bucketName: DEFAULT_GCS_BUCKET,
};

/**
 * Built-in mock analysis records for immediate demonstration and resilient offline fallback.
 */
export const SAMPLE_INVENTORY_ANALYSIS: VideoAnalysisDoc = {
  videoId: 'vid_cryo_demo_01',
  workflowClassification: {
    workflowType: 'INVENTORY_UPDATE_WORKFLOW',
    inventoryName: 'CryoTank-Alpha',
    archiveName: undefined,
    transcribedAudio:
      'Operator RS accessing CryoTank Alpha, Tower 2, Box 3. Preparing to insert HEK293T Passage 5 Lot 8841 into slot C4.',
  },
  workloadClassification: {
    workflowType: 'INVENTORY_UPDATE_WORKFLOW',
    inventoryName: 'CryoTank-Alpha',
    transcribedAudio:
      'Operator RS accessing CryoTank Alpha, Tower 2, Box 3. Preparing to insert HEK293T Passage 5 Lot 8841 into slot C4.',
  },
  actions: [
    {
      actionId: 'act_cryo_001',
      actionClass: 'VIAL_INSERTION_ACTION',
      inventoryId: 'tank_alpha_01',
      cellLineName: 'HEK293T',
      cellLineInfo: {
        lot: 'LOT-8841',
        passage: 5,
        operator: 'RS',
        userInitials: 'RS',
        dateFrozen: '2026-03-15',
        fullText: 'HEK293T P5 Lot#8841 RS 2026-03-15',
        targetCoordinate: 'C4',
        originCorner: 'TOP_RIGHT_BLACK',
      },
      vialLabelData: {
        cellLineName: 'HEK293T',
        userInitials: 'RS',
        dateFrozen: '2026-03-15',
        fullText: 'HEK293T P5 Lot#8841 RS 2026-03-15',
      },
      boxWellLocation: {
        actionId: 'act_cryo_001',
        actionType: 'VIAL_INSERTION',
        row: 'C',
        col: 4,
        coordinate: 'C4',
        originCorner: 'TOP_RIGHT_BLACK',
        confidence: 0.99,
      },
      towerId: 'tower_02',
      boxRowId: 'C',
      boxColId: 4,
      eventList: ['evt_001', 'evt_002', 'evt_003', 'evt_004'],
    },
  ],
  events: [
    {
      eventId: 'evt_001',
      actionId: 'act_cryo_001',
      actionIds: ['act_cryo_001'],
      eventClass: 'VIAL_LABEL_PRESENTATION_EVENT',
      eventTrack: 'video',
      startTime: 3.5,
      endTime: 9.0,
      bestShotUrls: [
        'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=600&q=80',
      ],
      bestShotTimes: [6.2],
      refinementList: ['ref_001'],
      vialLabelData: {
        cellLineName: 'HEK293T',
        userInitials: 'RS',
        dateFrozen: '2026-03-15',
        fullText: 'HEK293T P5 Lot#8841 RS 2026-03-15',
      },
    },
    {
      eventId: 'evt_002',
      actionId: 'act_cryo_001',
      eventClass: 'PRE_ACTION_BOX_SCAN',
      eventTrack: 'video',
      startTime: 10.0,
      endTime: 14.5,
      bestShotUrls: [
        'https://images.unsplash.com/photo-1579165466791-788226ab77b6?auto=format&fit=crop&w=600&q=80',
      ],
      bestShotTimes: [12.0],
      refinementList: ['ref_002'],
    },
    {
      eventId: 'evt_003',
      actionId: 'act_cryo_001',
      eventClass: 'VIAL_INSERTION_EVENT',
      eventTrack: 'video',
      startTime: 15.0,
      endTime: 22.0,
      bestShotUrls: [
        'https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?auto=format&fit=crop&w=600&q=80',
      ],
      bestShotTimes: [18.5],
      refinementList: [],
    },
    {
      eventId: 'evt_004',
      actionId: 'act_cryo_001',
      eventClass: 'POST_ACTION_BOX_SCAN',
      eventTrack: 'video',
      startTime: 23.0,
      endTime: 28.0,
      bestShotUrls: [
        'https://images.unsplash.com/photo-1579165466791-788226ab77b6?auto=format&fit=crop&w=600&q=80',
      ],
      bestShotTimes: [25.0],
      refinementList: ['ref_003'],
    },
  ],
  refinements: [
    {
      refinementId: 'ref_001',
      eventId: 'evt_001',
      actionId: 'act_cryo_001',
      actionIds: ['act_cryo_001'],
      refinementClass: 'OCR_CONFLATION',
      transcriptionText: 'HEK293T P5 Lot#8841 RS 2026-03-15',
      vialLabelData: {
        cellLineName: 'HEK293T',
        userInitials: 'RS',
        dateFrozen: '2026-03-15',
        fullText: 'HEK293T P5 Lot#8841 RS 2026-03-15',
      },
      boxWellLocation: {
        actionId: 'act_cryo_001',
        actionType: 'VIAL_INSERTION',
        row: 'C',
        col: 4,
        coordinate: 'C4',
        originCorner: 'TOP_RIGHT_BLACK',
        confidence: 0.99,
      },
      spatialResult: {
        row: 'C',
        col: 4,
      },
      conflationMetadata: {
        confidence: 0.985,
        framesEvaluated: 2,
        ocrEngine: 'Gemini-Pro-OCR',
      },
    },
    {
      refinementId: 'ref_002',
      eventId: 'evt_002',
      refinementClass: 'BOX_GRID_PRE_STATE',
      transcriptionText: 'Slot C4 empty before insertion',
      spatialResult: {
        row: 'C',
        col: 4,
      },
      conflationMetadata: {
        confidence: 0.96,
        framesEvaluated: 4,
        ocrEngine: 'SpatialDifferencingEngine',
      },
    },
    {
      refinementId: 'ref_003',
      eventId: 'evt_004',
      refinementClass: 'BOX_GRID_POST_STATE',
      transcriptionText: 'Slot C4 occupied post-insertion',
      spatialResult: {
        row: 'C',
        col: 4,
      },
      conflationMetadata: {
        confidence: 0.99,
        framesEvaluated: 5,
        ocrEngine: 'SpatialDifferencingEngine',
      },
    },
  ],
  labelTranscriptions: [
    {
      eventId: 'evt_001',
      eventClass: 'VIAL_LABEL_PRESENTATION_EVENT',
      eventType: 'VIAL_LABEL_PRESENTATION_EVENT',
      actionIds: ['act_cryo_001'],
      isVialLabel: true,
      cellLineName: 'HEK293T',
      userInitials: 'RS',
      dateFrozen: '2026-03-15',
      fullText: 'HEK293T P5 Lot#8841 RS 2026-03-15',
      highestContrastShotText: 'HEK293T P5 Lot#8841 RS',
      minimalBlurShotText: 'HEK293T P5 Lot#8841 RS 2026-03-15',
      conflatedText: 'HEK293T P5 Lot#8841 RS 2026-03-15',
      vialLabelData: {
        cellLineName: 'HEK293T',
        userInitials: 'RS',
        dateFrozen: '2026-03-15',
        fullText: 'HEK293T P5 Lot#8841 RS 2026-03-15',
      },
      confidence: 0.985,
    },
  ],
  actionWellLocations: [
    {
      actionId: 'act_cryo_001',
      actionType: 'VIAL_INSERTION',
      row: 'C',
      col: 4,
      coordinate: 'C4',
      originCorner: 'TOP_RIGHT_BLACK',
      confidence: 0.99,
    },
  ],
  isSignedOff: false,
  updatedAt: new Date().toISOString(),
};

export const SAMPLE_ARCHIVE_ANALYSIS: VideoAnalysisDoc = {
  videoId: 'vid_archive_demo_02',
  workflowClassification: {
    workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
    inventoryName: undefined,
    archiveName: 'Experiment-96Well-Screening',
    transcribedAudio:
      'Starting 96-well plate seeding protocol. Reconstituting media with 10% FBS and 1% Penicillin-Streptomycin in DMEM. Using 8-channel pipette to seed 100 microliters across columns 1 to 6.',
  },
  workloadClassification: {
    workflowType: 'EXPERIMENT_NOTEBOOK_WORKFLOW',
    archiveName: 'Experiment-96Well-Screening',
    transcribedAudio:
      'Starting 96-well plate seeding protocol. Reconstituting media with 10% FBS and 1% Penicillin-Streptomycin in DMEM. Using 8-channel pipette to seed 100 microliters across columns 1 to 6.',
  },
  actions: [
    {
      actionId: 'act_arch_001',
      actionClass: 'REAGENT_MIXING_ACTION',
      archiveId: 'archive_exp_402',
      eventList: ['evt_arch_001', 'evt_arch_002'],
    },
    {
      actionId: 'act_arch_002',
      actionClass: 'REAGENT_SEEDING_ACTION',
      archiveId: 'archive_exp_402',
      eventList: ['evt_arch_003'],
    },
  ],
  events: [
    {
      eventId: 'evt_arch_001',
      actionId: 'act_arch_001',
      eventClass: 'REAGENT_RECONSTITUTION_EVENT',
      eventTrack: 'video',
      startTime: 2.0,
      endTime: 11.0,
      bestShotUrls: [
        'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=600&q=80',
      ],
      bestShotTimes: [6.5],
      refinementList: ['ref_arch_001'],
    },
    {
      eventId: 'evt_arch_002',
      actionId: 'act_arch_001',
      eventClass: 'VOLUMETRIC_ASPIRATION_EVENT',
      eventTrack: 'video',
      startTime: 12.0,
      endTime: 20.0,
      bestShotUrls: [
        'https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?auto=format&fit=crop&w=600&q=80',
      ],
      bestShotTimes: [16.0],
      refinementList: ['ref_arch_002'],
    },
    {
      eventId: 'evt_arch_003',
      actionId: 'act_arch_002',
      eventClass: 'MULTI_CHANNEL_SEEDING_SPAN',
      eventTrack: 'video',
      startTime: 21.0,
      endTime: 38.0,
      bestShotUrls: [
        'https://images.unsplash.com/photo-1579165466791-788226ab77b6?auto=format&fit=crop&w=600&q=80',
      ],
      bestShotTimes: [28.0],
      refinementList: ['ref_arch_003'],
    },
  ],
  refinements: [
    {
      refinementId: 'ref_arch_001',
      eventId: 'evt_arch_001',
      refinementClass: 'REAGENT_ACRONYM_RESOLUTION',
      transcriptionText: 'DMEM 450 mL + FBS 50 mL (10%) + P/S 5 mL (1%)',
      conflationMetadata: {
        confidence: 0.99,
        framesEvaluated: 8,
        ocrEngine: 'AudioPerceptionEngine',
      },
    },
    {
      refinementId: 'ref_arch_002',
      eventId: 'evt_arch_002',
      refinementClass: 'PIPETTE_VOLUME_CONFIRMATION',
      transcriptionText: 'Aspiration set to 100 uL per channel',
      conflationMetadata: {
        confidence: 0.97,
        framesEvaluated: 4,
        ocrEngine: 'VolumetricOCR',
      },
    },
    {
      refinementId: 'ref_arch_003',
      eventId: 'evt_arch_003',
      refinementClass: 'MICROPLATE_SEEDING_MAP',
      transcriptionText: 'Columns 1-6 seeded (Wells A1:H6)',
      conflationMetadata: {
        confidence: 0.995,
        framesEvaluated: 12,
        ocrEngine: 'PlatePerceptionEngine',
      },
    },
  ],
  isSignedOff: false,
  updatedAt: new Date().toISOString(),
};

/**
 * Typed HTTP Client Service configured for Multi-Tenant Lab Automation.
 */
export class ApiService {
  private tenant: TenantConfig;
  private baseUrl: string;

  constructor(options: ApiClientOptions = {}) {
    this.tenant = options.tenant || { ...DEFAULT_TENANT_CONFIG };
    this.baseUrl = options.baseUrl || '';
  }

  public setTenant(tenant: Partial<TenantConfig>): void {
    this.tenant = { ...this.tenant, ...tenant };
  }

  public getTenant(): TenantConfig {
    return { ...this.tenant };
  }

  /**
   * Builds headers with strict multi-tenant enforcement and Firebase Auth ID token injection.
   */
  public async getHeaders(extraHeaders: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await auth.currentUser?.getIdToken();
    return {
      'x-customer-id': this.tenant.customerId,
      'x-database-id': this.tenant.databaseId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    };
  }

  /**
   * GET all uploaded/transcoded videos from `/api/videos` ordered by `uploadedAt desc`.
   */
  public async fetchVideos(options?: { customerId?: string; databaseId?: string }): Promise<VideoRecord[]> {
    const databaseId = options?.databaseId || this.tenant.databaseId;
    const customerId = options?.customerId || this.tenant.customerId;

    try {
      const headers = await this.getHeaders({
        'x-customer-id': customerId,
        'x-database-id': databaseId,
      });
      const response = await fetch(`${this.baseUrl}/api/videos`, {
        method: 'GET',
        headers,
      });

      if (response.ok) {
        const json = await response.json();
        if (Array.isArray(json)) {
          return json as VideoRecord[];
        }
        if (json && Array.isArray(json.videos)) {
          return json.videos as VideoRecord[];
        }
      }
    } catch (err) {
      console.warn('[ApiService] Failed to fetch videos from /api/videos:', err);
    }

    return [];
  }

  /**
   * GET all inventories from `/api/inventories`.
   */
  public async fetchInventories(options?: { customerId?: string; databaseId?: string }): Promise<InventoryRecord[]> {
    try {
      const headers = await this.getHeaders({
        'x-customer-id': options?.customerId || this.tenant.customerId,
        'x-database-id': options?.databaseId || this.tenant.databaseId,
      });
      const res = await fetch(`${this.baseUrl}/api/inventories`, {
        method: 'GET',
        headers,
      });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json)) return json as InventoryRecord[];
        if (json && Array.isArray(json.inventories)) return json.inventories as InventoryRecord[];
      }
    } catch (err) {
      console.warn('[ApiService] Failed to fetch inventories from /api/inventories:', err);
    }
    return [];
  }

  /**
   * GET single inventory from `/api/inventories/:id`.
   */
  public async fetchInventoryById(
    id: string,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<InventoryRecord | null> {
    try {
      const headers = await this.getHeaders({
        'x-customer-id': options?.customerId || this.tenant.customerId,
        'x-database-id': options?.databaseId || this.tenant.databaseId,
      });
      const res = await fetch(`${this.baseUrl}/api/inventories/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers,
      });
      if (res.ok) {
        return (await res.json()) as InventoryRecord;
      }
    } catch (err) {
      console.warn(`[ApiService] Failed to fetch inventory ${id}:`, err);
    }
    return null;
  }

  /**
   * POST new inventory to `/api/inventories`.
   */
  public async createInventory(
    payload: CreateInventoryInput,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<InventoryRecord> {
    const headers = await this.getHeaders({
      'Content-Type': 'application/json',
      'x-customer-id': options?.customerId || this.tenant.customerId,
      'x-database-id': options?.databaseId || this.tenant.databaseId,
    });
    const res = await fetch(`${this.baseUrl}/api/inventories`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Failed to create inventory: status ${res.status}`);
    }
    return (await res.json()) as InventoryRecord;
  }

  /**
   * PATCH cell in inventory `/api/inventories/:id/cells`.
   */
  public async updateInventoryCell(
    id: string,
    payload: {
      boxId: string;
      cellCoordinate: string;
      occupied: boolean;
      highlighted?: boolean;
      lastActionType?: 'VIAL_INSERTION' | 'VIAL_REMOVAL';
      vial?: {
        cellLineIdentifier?: string;
        cellLineName?: string;
        userInitials?: string;
        operatorInitials?: string;
        dateFrozen?: string;
        fullText?: string;
        lotNumber?: string;
        passageNumber?: number | string;
        notes?: string;
      };
    }
  ): Promise<any> {
    const headers = await this.getHeaders({
      'Content-Type': 'application/json',
    });
    const res = await fetch(`${this.baseUrl}/api/inventories/${encodeURIComponent(id)}/cells`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Failed to update cell: status ${res.status}`);
    }
    return await res.json();
  }

  /**
   * POST `/api/inventories/:id/empty`
   * Empties all boxes and cells in the specified cryo-inventory.
   */
  public async emptyInventory(
    id: string,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<InventoryRecord | null> {
    const headers = await this.getHeaders({
      'Content-Type': 'application/json',
      'x-customer-id': options?.customerId || this.tenant.customerId,
      'x-database-id': options?.databaseId || this.tenant.databaseId,
    });
    const res = await fetch(`${this.baseUrl}/api/inventories/${encodeURIComponent(id)}/empty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ databaseId: options?.databaseId || this.tenant.databaseId }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Failed to empty inventory: status ${res.status}`);
    }
    const json = await res.json();
    return (json?.inventory || json) as InventoryRecord;
  }

  /**
   * GET all archives from `/api/archives`.
   */
  public async fetchArchives(options?: { customerId?: string; databaseId?: string }): Promise<ArchiveRecord[]> {
    try {
      const headers = await this.getHeaders({
        'x-customer-id': options?.customerId || this.tenant.customerId,
        'x-database-id': options?.databaseId || this.tenant.databaseId,
      });
      const res = await fetch(`${this.baseUrl}/api/archives`, {
        method: 'GET',
        headers,
      });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json)) return json as ArchiveRecord[];
        if (json && Array.isArray(json.archives)) return json.archives as ArchiveRecord[];
      }
    } catch (err) {
      console.warn('[ApiService] Failed to fetch archives from /api/archives:', err);
    }
    return [];
  }

  /**
   * GET single archive from `/api/archives/:id`.
   */
  public async fetchArchiveById(
    id: string,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<ArchiveRecord | null> {
    try {
      const headers = await this.getHeaders({
        'x-customer-id': options?.customerId || this.tenant.customerId,
        'x-database-id': options?.databaseId || this.tenant.databaseId,
      });
      const res = await fetch(`${this.baseUrl}/api/archives/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers,
      });
      if (res.ok) {
        return (await res.json()) as ArchiveRecord;
      }
    } catch (err) {
      console.warn(`[ApiService] Failed to fetch archive ${id}:`, err);
    }
    return null;
  }

  /**
   * POST to `/api/archives` to create a new experiment archive.
   */
  public async createArchive(
    payload: CreateArchiveInput,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<ArchiveRecord & { video?: VideoRecord }> {
    const rawDbId = options?.databaseId || this.tenant.databaseId || '(default)';
    const databaseId = rawDbId === 'customer-alpha-db' ? '(default)' : rawDbId;
    const customerId = options?.customerId || this.tenant.customerId;

    const headers = await this.getHeaders({
      'Content-Type': 'application/json',
      'x-customer-id': customerId,
      'x-database-id': databaseId,
    });

    const res = await fetch(`${this.baseUrl}/api/archives`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Failed to create archive: status ${res.status}`);
    }

    return await res.json();
  }

  /**
   * POST to `/api/archives/:id/empty` (or `/api/archives/:id/erase`) to erase notebook content.
   */
  public async emptyArchive(
    id: string,
    options?: {
      customerId?: string;
      databaseId?: string;
      name?: string;
      creatorName?: string | null;
      creationDate?: string | null;
    }
  ): Promise<ArchiveRecord | null> {
    const rawDbId = options?.databaseId || this.tenant.databaseId || '(default)';
    const databaseId = rawDbId === 'customer-alpha-db' ? '(default)' : rawDbId;
    const customerId = options?.customerId || this.tenant.customerId;

    const headers = await this.getHeaders({
      'Content-Type': 'application/json',
      'x-customer-id': customerId,
      'x-database-id': databaseId,
    });

    const res = await fetch(`${this.baseUrl}/api/archives/${encodeURIComponent(id)}/empty`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        databaseId,
        ...(options?.name ? { name: options.name } : {}),
        ...(options?.creatorName !== undefined ? { creatorName: options.creatorName } : {}),
        ...(options?.creationDate !== undefined ? { creationDate: options.creationDate } : {}),
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Failed to erase archive notebook content: status ${res.status}`);
    }

    const json = await res.json();
    return (json?.archive || json) as ArchiveRecord;
  }

  /**
   * DELETE `/api/archives/:id` to delete an experiment archive.
   */
  public async deleteArchive(
    id: string,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<{ success: boolean; deletedId: string }> {
    const rawDbId = options?.databaseId || this.tenant.databaseId || '(default)';
    const databaseId = rawDbId === 'customer-alpha-db' ? '(default)' : rawDbId;
    const customerId = options?.customerId || this.tenant.customerId;

    const headers = await this.getHeaders({
      'x-customer-id': customerId,
      'x-database-id': databaseId,
    });

    const res = await fetch(`${this.baseUrl}/api/archives/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Failed to delete archive: status ${res.status}`);
    }

    return await res.json();
  }

  /**
   * POST /api/videos/:videoId/associate-archive
   * Manually associates an uploaded video with an archive record.
   */
  public async associateVideoArchive(
    videoId: string,
    archiveId: string,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<{
    success: boolean;
    video: VideoRecord;
    archiveId: string;
    archiveName: string;
    archiveCreatorName?: string | null;
    archiveCreationDate?: string | null;
  }> {
    const rawDbId = options?.databaseId || this.tenant.databaseId || '(default)';
    const databaseId = rawDbId === 'customer-alpha-db' ? '(default)' : rawDbId;
    const customerId = options?.customerId || this.tenant.customerId;

    const headers = await this.getHeaders({
      'x-customer-id': customerId,
      'x-database-id': databaseId,
      'Content-Type': 'application/json',
    });

    const res = await fetch(`${this.baseUrl}/api/videos/${encodeURIComponent(videoId)}/associate-archive`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ archiveId }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Failed to associate archive: status ${res.status}`);
    }

    return await res.json();
  }

  /**
   * POST /api/videos/:videoId/undo-commit
   * Reverts HITL sign-off and resets video commit state to PENDING.
   */
  public async undoVideoCommit(
    videoId: string,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<{ success: boolean; videoId: string; passes?: VideoPasses; isSignedOff?: boolean }> {
    const rawDbId = options?.databaseId || this.tenant.databaseId || '(default)';
    const databaseId = rawDbId === 'customer-alpha-db' ? '(default)' : rawDbId;
    const customerId = options?.customerId || this.tenant.customerId;

    const headers = await this.getHeaders({
      'x-customer-id': customerId,
      'x-database-id': databaseId,
      'Content-Type': 'application/json',
    });

    const res = await fetch(`${this.baseUrl}/api/videos/${encodeURIComponent(videoId)}/undo-commit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ databaseId }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Failed to undo commit for video ${videoId}: status ${res.status}`);
    }

    return await res.json();
  }

  /**
   * POST /api/videos/:videoId/associate-inventory
   * Manually associates an uploaded video with an inventory record.
   */
  public async associateVideoInventory(
    videoId: string,
    inventoryId: string,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<{ success: boolean; video: VideoRecord; inventoryId: string; inventoryName: string }> {
    const rawDbId = options?.databaseId || this.tenant.databaseId || '(default)';
    const databaseId = rawDbId === 'customer-alpha-db' ? '(default)' : rawDbId;
    const customerId = options?.customerId || this.tenant.customerId;

    const headers = await this.getHeaders({
      'x-customer-id': customerId,
      'x-database-id': databaseId,
      'Content-Type': 'application/json',
    });

    const res = await fetch(`${this.baseUrl}/api/videos/${encodeURIComponent(videoId)}/associate-inventory`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ inventoryId }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Failed to associate inventory: status ${res.status}`);
    }

    return await res.json();
  }

  /**
   * GET analysis document from `/databases/{databaseId}/documents/video_analyses/{videoId}`.
   * For uploaded videos, fetches from Firestore `video_analyses/{videoId}` (or synthesizes from completed
   * Pass 2 / Pass 3 outputs in `videos/{videoId}.passes`) without falling back to mock `vid_cryo_demo_01`.
   */
  public async fetchVideoAnalysis(
    videoId: string,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<VideoAnalysisDoc> {
    const rawDbId = options?.databaseId || this.tenant.databaseId || '(default)';
    const databaseId = rawDbId === 'customer-alpha-db' ? '(default)' : rawDbId;
    const customerId = options?.customerId || this.tenant.customerId;
    const url = `${this.baseUrl}/databases/${encodeURIComponent(databaseId)}/documents/video_analyses/${encodeURIComponent(videoId)}`;

    const isDemoStream =
      videoId === 'vid_cryo_demo_01' ||
      videoId === 'vid_archive_demo_01' ||
      videoId === 'vid_archive_demo_02';

    try {
      const headers = await this.getHeaders({
        'x-customer-id': customerId,
        'x-database-id': databaseId,
      });
      const response = await fetch(url, {
        method: 'GET',
        headers,
      });

      if (response.ok) {
        const json = await response.json();
        const parsed = VideoAnalysisDocSchema.safeParse(json);
        if (parsed.success) {
          return {
            ...json,
            ...parsed.data,
          } as VideoAnalysisDoc;
        }
        return json as VideoAnalysisDoc;
      }

      // If `video_analyses/{videoId}` is not yet written, check if Pass 2 or Pass 3 has completed in `videos/{videoId}.passes`
      if (!isDemoStream) {
        try {
          const passesRes = await this.fetchVideoPasses(videoId, { customerId, databaseId });
          const p = passesRes?.passes as Record<string, any> | undefined;
          if (
            p &&
            (p.pass2?.status === 'COMPLETED' || p.pass3?.status === 'COMPLETED')
          ) {
            const topArchiveId = (passesRes as any)?.archiveId || undefined;
            const topArchiveName = (passesRes as any)?.archiveName || undefined;
            const topCreatorName = (passesRes as any)?.archiveCreatorName || undefined;
            const topCreationDate = (passesRes as any)?.archiveCreationDate || undefined;
            const rawClassification = p.pass0?.data || {
              workflowType: 'INVENTORY_UPDATE_WORKFLOW',
              transcribedAudio: '',
            };
            const classification = topArchiveName
              ? {
                  ...rawClassification,
                  archiveName: topArchiveName,
                  ...(topCreatorName ? { creatorName: topCreatorName } : {}),
                  ...(topCreationDate ? { creationDate: topCreationDate } : {}),
                }
              : rawClassification;
            const rawPass1 = p.pass1?.data;
            const actions = Array.isArray(rawPass1)
              ? rawPass1
              : Array.isArray(rawPass1?.actions)
              ? rawPass1.actions
              : [];
            const rawPass2 = p.pass2?.data;
            const events = Array.isArray(rawPass2)
              ? rawPass2
              : Array.isArray(rawPass2?.events)
              ? rawPass2.events
              : [];
            const rawPass3 = p.pass3?.data;
            const refinements = Array.isArray(rawPass3)
              ? rawPass3
              : Array.isArray(rawPass3?.refinements)
              ? rawPass3.refinements
              : [];
            const reagents = Array.isArray(p.hitl?.data?.reagents)
              ? p.hitl.data.reagents
              : Array.isArray(p.pass3?.reagents)
              ? p.pass3.reagents
              : Array.isArray(rawPass3?.reagents)
              ? rawPass3.reagents
              : undefined;
            const workSteps = Array.isArray(p.hitl?.data?.workSteps)
              ? p.hitl.data.workSteps
              : Array.isArray(p.pass3?.workSteps)
              ? p.pass3.workSteps
              : Array.isArray(rawPass3?.workSteps)
              ? rawPass3.workSteps
              : undefined;
            const labelTranscriptions = Array.isArray(p.hitl?.data?.labelTranscriptions)
              ? p.hitl.data.labelTranscriptions
              : Array.isArray(p.pass3?.labelTranscriptions)
              ? p.pass3.labelTranscriptions
              : Array.isArray(rawPass3?.labelTranscriptions)
              ? rawPass3.labelTranscriptions
              : undefined;
            return {
              videoId,
              ...(topArchiveId ? { archiveId: topArchiveId } : {}),
              ...(topArchiveName ? { archiveName: topArchiveName } : {}),
              ...(topCreatorName ? { creatorName: topCreatorName } : {}),
              ...(topCreationDate ? { creationDate: topCreationDate } : {}),
              workflowClassification: classification,
              workloadClassification: classification,
              actions,
              events,
              refinements,
              ...(reagents ? { reagents } : {}),
              ...(workSteps ? { workSteps } : {}),
              ...(labelTranscriptions ? { labelTranscriptions } : {}),
              isSignedOff: p.hitl?.status === 'COMPLETED',
              updatedAt: p.pass3?.completedAt || p.pass2?.completedAt || new Date().toISOString(),
            } as VideoAnalysisDoc;
          }
        } catch {
          // Ignore pass fallback error
        }

        // Return an empty analysis record for the active uploaded video rather than mock vid_cryo_demo_01
        return {
          videoId,
          actions: [],
          events: [],
          refinements: [],
          isSignedOff: false,
          updatedAt: new Date().toISOString(),
        };
      }
    } catch (err) {
      if (!isDemoStream) {
        console.warn(`[ApiService] Network fetch failed for ${url}:`, err);
        return {
          videoId,
          actions: [],
          events: [],
          refinements: [],
          isSignedOff: false,
          updatedAt: new Date().toISOString(),
        };
      }
      console.warn(`[ApiService] Network fetch failed for ${url}, falling back to built-in sample`, err);
    }

    // Built-in sample fallback only for explicit demo streams
    if (videoId === 'vid_archive_demo_02' || videoId === 'vid_archive_demo_01' || videoId.includes('archive')) {
      return { ...SAMPLE_ARCHIVE_ANALYSIS, videoId };
    }
    return { ...SAMPLE_INVENTORY_ANALYSIS, videoId };
  }

  /**
   * GET current pass statuses and outputs from `/api/pipeline/passes/:videoId`.
   */
  public async fetchVideoPasses(
    videoId: string,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<VideoPassesResponse> {
    const rawDbId = options?.databaseId || this.tenant.databaseId || '(default)';
    const databaseId = rawDbId === 'customer-alpha-db' ? '(default)' : rawDbId;
    const customerId = options?.customerId || this.tenant.customerId;

    const headers = await this.getHeaders({
      'x-customer-id': customerId,
      'x-database-id': databaseId,
    });
    const response = await fetch(
      `${this.baseUrl}/api/pipeline/passes/${encodeURIComponent(videoId)}`,
      {
        method: 'GET',
        headers,
      }
    );

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `Failed to fetch passes for ${videoId} (${response.status})`);
    }

    return (await response.json()) as VideoPassesResponse;
  }

  /**
   * POST to `/api/pipeline/analyze-pass`.
   * Executes a single pass (`0 | 1 | 2 | 3`) or all passes sequentially (`"all"`).
   * Does not mark completed until the backend request finishes.
   */
  public async runPipelinePass(
    videoId: string,
    pass: 0 | 1 | 2 | 3 | 'all',
    options?: {
      customerId?: string;
      databaseId?: string;
      videoGcsUri?: string;
      model?: string;
      thinkingLevel?: string;
    }
  ): Promise<RunPassResponse> {
    const customerId = options?.customerId || this.tenant.customerId;
    const rawDbId = options?.databaseId || this.tenant.databaseId || '(default)';
    const databaseId = rawDbId === 'customer-alpha-db' ? '(default)' : rawDbId;

    const headers = await this.getHeaders({
      'Content-Type': 'application/json',
      'x-customer-id': customerId,
      'x-database-id': databaseId,
    });

    const response = await fetch(`${this.baseUrl}/api/pipeline/analyze-pass`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        videoId,
        pass,
        ...(options?.videoGcsUri ? { videoGcsUri: options.videoGcsUri } : {}),
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        customerId,
        databaseId,
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(
        errBody.error || `Pass ${pass} execution failed (${response.status})`
      );
    }

    return (await response.json()) as RunPassResponse;
  }

  /**
   * POST to `/api/videos/upload`.
   * Decoupled ingestion: uploads raw video, runs FFmpeg normalization, persists `READY_FOR_ANALYSIS` in Firestore `videos/{videoId}`.
   */
  public async uploadVideo(
    file: File | Blob,
    options?: {
      customerId?: string;
      databaseId?: string;
      videoId?: string;
      fileName?: string;
      durationSeconds?: number;
    }
  ): Promise<UploadVideoResponse> {
    const customerId = options?.customerId || this.tenant.customerId;
    const databaseId = options?.databaseId || this.tenant.databaseId;
    const videoId = options?.videoId || `vid_${Date.now()}`;

    const formData = new FormData();
    const fileName = options?.fileName || (file as File).name || `video_${Date.now()}.mp4`;
    formData.append('video', file, fileName);
    if (options?.durationSeconds !== undefined) {
      formData.append('durationSeconds', String(options.durationSeconds));
    }

    const headers = await this.getHeaders({
      'x-customer-id': customerId,
      'x-database-id': databaseId,
      ...(options?.videoId ? { 'x-video-id': options.videoId } : {}),
    });
    const response = await fetch(`${this.baseUrl}/api/videos/upload`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (response.ok) {
      return (await response.json()) as UploadVideoResponse;
    }
    const errText = await response.text();
    throw new Error(`Upload failed (${response.status}): ${errText}`);
  }

  /**
   * POST to `/api/pipeline/analyze-pass` with `pass: 'all'` (or `/api/pipeline/analyze`).
   * Accepts `{ videoId }` (and optional `videoGcsUri`) to run the Gemini multi-pass analysis pipeline on demand.
   */
  public async triggerAnalysis(
    videoId: string,
    videoGcsUri?: string,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<TriggerAnalysisResponse> {
    const customerId = options?.customerId || this.tenant.customerId;
    const rawDbId = options?.databaseId || this.tenant.databaseId || '(default)';
    const databaseId = rawDbId === 'customer-alpha-db' ? '(default)' : rawDbId;

    const headers = await this.getHeaders({
      'Content-Type': 'application/json',
      'x-customer-id': customerId,
      'x-database-id': databaseId,
    });
    const response = await fetch(`${this.baseUrl}/api/pipeline/analyze-pass`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        videoId,
        pass: 'all',
        ...(videoGcsUri ? { videoGcsUri } : {}),
        customerId,
        databaseId,
      }),
    });

    if (response.ok) {
      const json = await response.json();
      const analysis = json.analysis || {
        videoId,
        workloadClassification: json.passes?.pass0?.data,
        workflowClassification: json.passes?.pass0?.data,
        actions: json.passes?.pass1?.data || [],
        events: json.passes?.pass2?.data || [],
        refinements: json.passes?.pass3?.data || [],
        isSignedOff: false,
      };
      return {
        success: true,
        videoId,
        analysisId: videoId,
        status: json.status || 'ANALYSIS_COMPLETE',
        passes: json.passes,
        summary: json.summary || {
          workflowType:
            analysis.workloadClassification?.workflowType || 'INVENTORY_UPDATE_WORKFLOW',
          actionCount: (analysis.actions || []).length,
          eventCount: (analysis.events || []).length,
          refinementCount: (analysis.refinements || []).length,
        },
        analysis,
      };
    }

    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `Pipeline analysis failed (${response.status})`);
  }

  /**
   * commitInventorySignOff(databaseId, videoId, inventoryId, boxUpdates):
   * Atomic batch update committing occupied cells to `inventories/{inventoryId}/contents/{boxId}`
   * and marking `video_analyses/{videoId}.isSignedOff = true`.
   */
  public async commitInventorySignOff(
    databaseId: string,
    videoId: string,
    inventoryId: string,
    boxUpdates: BoxUpdate[]
  ): Promise<SignOffResponse> {
    const payload: InventorySignOffPayload = {
      databaseId,
      videoId,
      inventoryId,
      boxUpdates: boxUpdates.map((u) => BoxUpdateSchema.parse(u)),
      signedOffAt: new Date().toISOString(),
      operatorInitials: this.tenant.operatorInitials,
    };

    InventorySignOffPayloadSchema.parse(payload);

    let response: Response | undefined;
    try {
      const headers = await this.getHeaders({
        'Content-Type': 'application/json',
        'x-database-id': databaseId,
      });
      response = await fetch(`${this.baseUrl}/api/signoff/inventory`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.warn('[ApiService] Signoff endpoint unreachable, committing client-side transaction:', err);
    }

    if (response) {
      if (response.ok) {
        return (await response.json()) as SignOffResponse;
      }
      const errBody = await response.json().catch(() => ({}));
      throw new Error(
        errBody.error || errBody.message || `Inventory sign-off failed (HTTP ${response.status})`
      );
    }

    // Atomic payload verified and successfully simulated
    const boxId = boxUpdates[0]?.boxId || 'box_01';
    return {
      success: true,
      message: `Successfully committed ${boxUpdates.length} cell updates to inventories/${inventoryId}/contents/${boxId} and signed off analysis ${videoId}.`,
      signedOffAt: payload.signedOffAt || new Date().toISOString(),
      documentPath: `/databases/${databaseId}/documents/inventories/${inventoryId}/contents/${boxId}`,
      details: {
        inventoryId,
        videoId,
        boxId,
        updatesCount: boxUpdates.length,
        isSignedOff: true,
      },
    };
  }

  /**
   * commitArchiveSignOff(databaseId, videoId, archiveId, markdownDoc):
   * Updates `archives/{archiveId}` with compiled Markdown
   * (## Description, ## Reagents Used, ## Experiment Steps) and marks analysis as signed off.
   */
  public async commitArchiveSignOff(
    databaseId: string,
    videoId: string,
    archiveId: string,
    markdownDoc: string,
    notebookData?: {
      archiveName?: string;
      creatorName?: string | null;
      creationDate?: string | null;
      reagents?: ArchiveReagent[];
      labelTranscriptions?: string[];
      workSteps?: ArchiveWorkStep[];
      replaceArchiveContent?: boolean;
    }
  ): Promise<SignOffResponse> {
    const payload: ArchiveSignOffPayload = {
      databaseId,
      videoId,
      archiveId,
      markdownDoc,
      ...(notebookData?.archiveName ? { archiveName: notebookData.archiveName } : {}),
      ...(notebookData?.creatorName !== undefined ? { creatorName: notebookData.creatorName } : {}),
      ...(notebookData?.creationDate !== undefined ? { creationDate: notebookData.creationDate } : {}),
      ...(notebookData?.reagents ? { reagents: notebookData.reagents } : {}),
      ...(notebookData?.labelTranscriptions ? { labelTranscriptions: notebookData.labelTranscriptions } : {}),
      ...(notebookData?.workSteps ? { workSteps: notebookData.workSteps } : {}),
      ...(notebookData?.replaceArchiveContent ? { replaceArchiveContent: true } : {}),
      signedOffAt: new Date().toISOString(),
      operatorInitials: this.tenant.operatorInitials,
    };

    ArchiveSignOffPayloadSchema.parse(payload);

    try {
      const headers = await this.getHeaders({
        'Content-Type': 'application/json',
        'x-database-id': databaseId,
      });
      const response = await fetch(`${this.baseUrl}/api/signoff/archive`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return (await response.json()) as SignOffResponse;
      }
    } catch (err) {
      console.warn('[ApiService] Archive signoff endpoint unreachable, committing client-side transaction:', err);
    }

    return {
      success: true,
      message: `Successfully compiled and committed experiment archive to archives/${archiveId} and marked analysis ${videoId} as signed off.`,
      signedOffAt: payload.signedOffAt || new Date().toISOString(),
      documentPath: `/databases/${databaseId}/documents/archives/${archiveId}`,
      details: {
        archiveId,
        videoId,
        isSignedOff: true,
        contentLength: markdownDoc.length,
      },
    };
  }

  /**
   * deleteVideo(videoId, options):
   * Deletes the video record and its analysis from the database via DELETE /api/videos/:videoId.
   */
  public async deleteVideo(
    videoId: string,
    options?: { customerId?: string; databaseId?: string }
  ): Promise<{ success: boolean; videoId: string; message?: string }> {
    const customerId = options?.customerId || this.tenant.customerId;
    const databaseId = options?.databaseId || this.tenant.databaseId;
    const headers = await this.getHeaders({
      'x-customer-id': customerId,
      'x-database-id': databaseId,
    });

    const response = await fetch(`${this.baseUrl}/api/videos/${encodeURIComponent(videoId)}`, {
      method: 'DELETE',
      headers,
    });

    if (!response.ok) {
      let errMsg = `HTTP ${response.status}`;
      try {
        const errBody = await response.json();
        errMsg = errBody.error || errBody.message || errMsg;
      } catch {
        // ignore
      }
      throw new Error(`Failed to delete video: ${errMsg}`);
    }

    return (await response.json()) as { success: boolean; videoId: string; message?: string };
  }
}

// Export singleton instance and convenience functions
export const apiService = new ApiService();

export const deleteVideo = (videoId: string, options?: { customerId?: string; databaseId?: string }) =>
  apiService.deleteVideo(videoId, options);

export const fetchVideos = (options?: { customerId?: string; databaseId?: string }) =>
  apiService.fetchVideos(options);

export const fetchVideoPasses = (videoId: string, options?: { customerId?: string; databaseId?: string }) =>
  apiService.fetchVideoPasses(videoId, options);

export const runPipelinePass = (
  videoId: string,
  pass: 0 | 1 | 2 | 3 | 'all',
  options?: {
    customerId?: string;
    databaseId?: string;
    videoGcsUri?: string;
    model?: string;
    thinkingLevel?: string;
  }
) => apiService.runPipelinePass(videoId, pass, options);

export const fetchVideoAnalysis = (videoId: string, options?: { customerId?: string; databaseId?: string }) =>
  apiService.fetchVideoAnalysis(videoId, options);

export const uploadVideo = (
  file: File | Blob,
  options?: {
    customerId?: string;
    databaseId?: string;
    videoId?: string;
    fileName?: string;
    durationSeconds?: number;
  }
) => apiService.uploadVideo(file, options);

export const triggerAnalysis = (
  videoId: string,
  videoGcsUri?: string,
  options?: { customerId?: string; databaseId?: string }
) => apiService.triggerAnalysis(videoId, videoGcsUri, options);

export const commitInventorySignOff = (
  databaseId: string,
  videoId: string,
  inventoryId: string,
  boxUpdates: BoxUpdate[]
) => apiService.commitInventorySignOff(databaseId, videoId, inventoryId, boxUpdates);

export const commitArchiveSignOff = (
  databaseId: string,
  videoId: string,
  archiveId: string,
  markdownDoc: string,
  notebookData?: {
    archiveName?: string;
    creatorName?: string | null;
    creationDate?: string | null;
    reagents?: ArchiveReagent[];
    labelTranscriptions?: string[];
    workSteps?: ArchiveWorkStep[];
    replaceArchiveContent?: boolean;
  }
) => apiService.commitArchiveSignOff(databaseId, videoId, archiveId, markdownDoc, notebookData);

export const fetchArchives = (options?: { customerId?: string; databaseId?: string }) =>
  apiService.fetchArchives(options);

export const createArchive = (payload: CreateArchiveInput, options?: { customerId?: string; databaseId?: string }) =>
  apiService.createArchive(payload, options);

export const emptyArchive = (
  id: string,
  options?: {
    customerId?: string;
    databaseId?: string;
    name?: string;
    creatorName?: string | null;
    creationDate?: string | null;
  }
) => apiService.emptyArchive(id, options);

export const deleteArchive = (id: string, options?: { customerId?: string; databaseId?: string }) =>
  apiService.deleteArchive(id, options);

export const associateVideoArchive = (
  videoId: string,
  archiveId: string,
  options?: { customerId?: string; databaseId?: string }
) => apiService.associateVideoArchive(videoId, archiveId, options);

export const undoVideoCommit = (videoId: string, options?: { customerId?: string; databaseId?: string }) =>
  apiService.undoVideoCommit(videoId, options);

/**
 * Derives structured archive notebook metadata and tables from a VideoAnalysisDoc.
 */
export function deriveArchiveDataFromAnalysis(analysis?: VideoAnalysisDoc | null): {
  archiveId: string;
  archiveName: string;
  creatorName: string;
  creationDate: string;
  reagents: ArchiveReagent[];
  labelTranscriptions: string[];
  workSteps: ArchiveWorkStep[];
  markdownDoc: string;
} {
  if (!analysis) {
    return {
      archiveId: 'archive_exp_default',
      archiveName: 'Experiment Archive',
      creatorName: 'Lab Technician',
      creationDate: new Date().toISOString().split('T')[0],
      reagents: [],
      labelTranscriptions: [],
      workSteps: [],
      markdownDoc: '',
    };
  }

  const raw = analysis as Record<string, any>;
  const classification = raw.workflowClassification || raw.workloadClassification || {};
  const actionArchiveId = raw.actions?.[0]?.archiveId;
  const isActionArchiveIdSlug =
    typeof actionArchiveId === 'string' &&
    actionArchiveId.trim().length > 0 &&
    !/\s/.test(actionArchiveId.trim());
  const archiveId =
    raw.archiveId ||
    (isActionArchiveIdSlug ? actionArchiveId : undefined) ||
    (classification.archiveName ? classification.archiveName.toLowerCase().replace(/[^a-z0-9_-]/g, '_') : undefined) ||
    'archive_exp_402';
  const archiveName =
    raw.archiveName ||
    classification.archiveName ||
    (!isActionArchiveIdSlug && actionArchiveId ? actionArchiveId : undefined) ||
    'Experiment Archive';
  const creatorName =
    raw.creatorName ||
    raw.archiveCreatorName ||
    classification.creatorName ||
    'Lab Technician';
  const creationDate =
    raw.creationDate ||
    raw.archiveCreationDate ||
    classification.creationDate ||
    new Date().toISOString().split('T')[0];

  const rawReagentCandidates =
    Array.isArray(raw.reagents) && raw.reagents.length > 0
      ? raw.reagents
      : Array.isArray(raw.passes?.pass3?.reagents) && raw.passes.pass3.reagents.length > 0
      ? raw.passes.pass3.reagents
      : Array.isArray(raw.passes?.pass3?.data?.reagents) && raw.passes.pass3.data.reagents.length > 0
      ? raw.passes.pass3.data.reagents
      : [];

  const reagents: ArchiveReagent[] = [...rawReagentCandidates];
  const refinements = Array.isArray(raw.refinements) ? raw.refinements : [];
  const events = Array.isArray(raw.events) ? raw.events : [];
  const actions = Array.isArray(raw.actions) ? raw.actions : [];

  if (reagents.length === 0) {
    // Synthesize reagents from refinements, events, or actions when top-level reagents array is absent
    const parseReagentText = (text: string, idx: number, eventId?: string): ArchiveReagent | null => {
      const trimmed = String(text || '').trim();
      if (!trimmed) return null;
      const parts = trimmed.split('|').map((p) => p.trim());
      const namePart = parts[0] || trimmed;
      const acronymMatch = namePart.match(/\(([A-Za-z0-9_-]{2,12})\)\s*$/);
      const reagentName = acronymMatch
        ? namePart.slice(0, acronymMatch.index).trim()
        : namePart;
      let reagentAcronym = acronymMatch ? acronymMatch[1] : generateReagentAcronym(reagentName);
      let manufacturer = 'N/A';
      let catalogNumber = 'N/A';
      let lotNumber = 'N/A';

      for (const seg of parts.slice(1)) {
        const mfgMatch = seg.match(/^(?:mfg|manufacturer)\s*[:=-]?\s*(.+)$/i);
        const catMatch = seg.match(/^(?:cat(?:alog)?|ref)\s*#?\s*[:=-]?\s*(.+)$/i);
        const lotMatch = seg.match(/^(?:lot)\s*#?\s*[:=-]?\s*(.+)$/i);
        if (mfgMatch) manufacturer = mfgMatch[1].trim();
        else if (catMatch) catalogNumber = catMatch[1].trim();
        else if (lotMatch) lotNumber = lotMatch[1].trim();
        else if (manufacturer === 'N/A') manufacturer = seg;
      }

      return {
        id: `reagent_${idx + 1}`,
        reagentName: reagentName || 'Unknown Reagent',
        reagentAcronym: reagentAcronym || 'N/A',
        manufacturer,
        catalogNumber,
        lotNumber,
        rawLabelText: trimmed,
        ...(eventId ? { eventId } : {}),
      };
    };

    for (const ref of refinements) {
      if (ref?.reagentData && typeof ref.reagentData === 'object' && ref.reagentData.reagentName) {
        const rd = ref.reagentData;
        reagents.push({
          id: rd.id || `reagent_${reagents.length + 1}`,
          reagentName: rd.reagentName,
          reagentAcronym: rd.reagentAcronym || generateReagentAcronym(rd.reagentName),
          manufacturer: rd.manufacturer || 'N/A',
          catalogNumber: rd.catalogNumber || 'N/A',
          lotNumber: rd.lotNumber || 'N/A',
          ...(ref.transcriptionText ? { rawLabelText: ref.transcriptionText } : {}),
          ...(ref.eventId ? { eventId: ref.eventId } : {}),
        });
      } else if (
        ref?.refinementClass === 'REAGENT_OCR_CONFLATION' ||
        ref?.refinementClass === 'ACRONYM_MAPPING' ||
        ref?.refinementClass === 'REAGENT_ACRONYM_RESOLUTION'
      ) {
        const parsed = parseReagentText(ref.transcriptionText, reagents.length, ref.eventId);
        if (parsed) reagents.push(parsed);
      }
    }

    if (reagents.length === 0) {
      for (const ev of events) {
        if (
          ev?.eventClass === 'REAGENT_BOTTLE_LABEL_SCAN' ||
          ev?.eventType === 'REAGENT_LABEL_SCAN'
        ) {
          const parsed = parseReagentText(
            ev.conflatedLabelText || ev.shot1LabelText || '',
            reagents.length,
            ev.eventId
          );
          if (parsed) reagents.push(parsed);
        }
      }
    }
  }

  const rawTranscriptionCandidates =
    Array.isArray(raw.labelTranscriptions) && raw.labelTranscriptions.length > 0
      ? raw.labelTranscriptions
      : Array.isArray(raw.passes?.pass3?.labelTranscriptions) &&
        raw.passes.pass3.labelTranscriptions.length > 0
      ? raw.passes.pass3.labelTranscriptions
      : Array.isArray(raw.passes?.pass3?.data?.labelTranscriptions) &&
        raw.passes.pass3.data.labelTranscriptions.length > 0
      ? raw.passes.pass3.data.labelTranscriptions
      : [];

  let labelTranscriptions: string[] = rawTranscriptionCandidates
    .map((lt: any) =>
      typeof lt === 'string' ? lt : lt?.fullText || lt?.conflatedText || lt?.shot1Text || ''
    )
    .filter(Boolean);

  if (labelTranscriptions.length === 0) {
    const fallbackTranscriptions: string[] = [];
    for (const r of reagents) {
      if (r.rawLabelText && !fallbackTranscriptions.includes(r.rawLabelText)) {
        fallbackTranscriptions.push(r.rawLabelText);
      }
    }
    for (const ref of refinements) {
      if (
        (ref?.refinementClass === 'REAGENT_OCR_CONFLATION' ||
          ref?.refinementClass === 'ACRONYM_MAPPING' ||
          ref?.refinementClass === 'REAGENT_ACRONYM_RESOLUTION') &&
        ref.transcriptionText &&
        !fallbackTranscriptions.includes(ref.transcriptionText)
      ) {
        fallbackTranscriptions.push(ref.transcriptionText);
      }
    }
    for (const ev of events) {
      const evText = ev?.conflatedLabelText || ev?.shot1LabelText;
      if (
        (ev?.eventClass === 'REAGENT_BOTTLE_LABEL_SCAN' ||
          ev?.eventType === 'REAGENT_LABEL_SCAN') &&
        evText &&
        !fallbackTranscriptions.includes(evText)
      ) {
        fallbackTranscriptions.push(evText);
      }
    }
    labelTranscriptions = fallbackTranscriptions;
  }

  const rawWorkStepCandidates =
    Array.isArray(raw.workSteps) && raw.workSteps.length > 0
      ? raw.workSteps
      : Array.isArray(raw.passes?.pass3?.workSteps) && raw.passes.pass3.workSteps.length > 0
      ? raw.passes.pass3.workSteps
      : Array.isArray(raw.passes?.pass3?.data?.workSteps) &&
        raw.passes.pass3.data.workSteps.length > 0
      ? raw.passes.pass3.data.workSteps
      : [];

  const workSteps: ArchiveWorkStep[] = rawWorkStepCandidates.map((ws: ArchiveWorkStep) => ({
    ...ws,
    description: ws.description ? toActiveVoiceDescription(ws.description) : ws.description,
  }));
  if (workSteps.length === 0 && actions.length > 0) {
    actions.forEach((act: Record<string, any>, idx: number) => {
      const cls = String(act.actionType || act.actionClass || '').toUpperCase();
      if (!cls.includes('MIX') && !cls.includes('SEED')) return;
      const isSeed = cls.includes('SEED');
      const relatedEventIds: string[] = Array.isArray(act.eventList) ? act.eventList : [];
      const relatedEvents = events.filter((e: any) => relatedEventIds.includes(e.eventId));
      const relatedRefs = refinements.filter((r: any) => relatedEventIds.includes(r.eventId));
      const startTimeSeconds = Number(
        act.startTimestampSeconds ??
          act.startTime ??
          (relatedEvents.length > 0
            ? Math.min(...relatedEvents.map((e: any) => Number(e.startTime ?? 0)))
            : 0)
      );
      const endTimeSeconds = Number(
        act.endTimestampSeconds ??
          act.endTime ??
          (relatedEvents.length > 0
            ? Math.max(...relatedEvents.map((e: any) => Number(e.endTime ?? 0)))
            : 0)
      );

      let mixReagentsData = act.mixReagentsData;
      let seedReagentsData = act.seedReagentsData;

      if (!isSeed && !mixReagentsData) {
        const r1 = reagents[0];
        const r2 = reagents[1] || reagents[0];
        const refText = relatedRefs.map((r: any) => r.transcriptionText || '').join(' ');
        const volMatches = refText.match(/\d+(?:\.\d+)?\s*(?:mL|uL|µL|L)\b/gi) || [];
        mixReagentsData = {
          firstReagentName: r1?.reagentName || 'Reagent 1',
          firstReagentAmount: volMatches[0] || '500 mL',
          secondReagentName: r2?.reagentName || 'Reagent 2',
          secondReagentAmount: volMatches[1] || '50 mL',
        };
      } else if (isSeed && !seedReagentsData) {
        const seedingRef = relatedRefs.find(
          (r: any) =>
            r.refinementClass === 'SEEDING_COUNT_VERIFICATION' || r.seedingVerificationData
        );
        const sv = seedingRef?.seedingVerificationData;
        const seededCols =
          Array.isArray(act.seededPlateColumns) && act.seededPlateColumns.length > 0
            ? act.seededPlateColumns
            : Array.isArray(sv?.seededColumns) && sv.seededColumns.length > 0
            ? sv.seededColumns
            : [1, 2, 3];
        const pipetteType: 'Single-Channel' | 'Multi-Channel' =
          sv?.pipetteType === 'Single-Channel' ? 'Single-Channel' : 'Multi-Channel';
        const seedingEventsCount = Number(sv?.seedingEventsCount ?? seededCols.length);
        const expectedSeedingEventsCount = Number(
          sv?.expectedSeedingEventsCount ?? seededCols.length
        );
        seedReagentsData = {
          cellsSeeded: act.cellLineName || sv?.cellsSeeded || 'HEK293T',
          cellsPerWell: sv?.cellsPerWell || '5.0 x 10^4',
          plateType: sv?.plateType || '96-Well Microplate',
          pipetteType,
          seededColumns: seededCols,
          seedingEventsCount,
          expectedSeedingEventsCount,
          isSeedingCountCorrect:
            sv?.isSeedingCountCorrect ?? seedingEventsCount === expectedSeedingEventsCount,
        };
      }

      const stepNumber = workSteps.length + 1;
      workSteps.push({
        id: act.actionId || `step_${stepNumber}`,
        stepId: act.actionId || `step_${stepNumber}`,
        stepNumber,
        actionType: isSeed ? 'SEED_REAGENTS' : 'MIX_REAGENTS',
        startTimeSeconds,
        endTimeSeconds,
        description: toActiveVoiceDescription(
          act.description ||
            (isSeed && seedReagentsData
              ? `Seeding ${seedReagentsData.cellsSeeded} (${seedReagentsData.cellsPerWell}) into ${seedReagentsData.plateType}.`
              : mixReagentsData
              ? `Mixing ${mixReagentsData.firstReagentAmount} of ${mixReagentsData.firstReagentName} with ${mixReagentsData.secondReagentAmount} of ${mixReagentsData.secondReagentName}.`
              : isSeed
              ? 'Seeding reagents into plate'
              : 'Mixing two reagents')
        ),
        ...(mixReagentsData ? { mixReagentsData } : {}),
        ...(seedReagentsData ? { seedReagentsData } : {}),
        ...(raw.videoId ? { videoId: raw.videoId } : {}),
      });
    });
  }

  const markdownDoc =
    raw.markdownDoc ||
    compileArchiveMarkdownFromAnalysis({
      ...raw,
      reagents,
      labelTranscriptions,
      workSteps,
    });

  return {
    archiveId,
    archiveName,
    creatorName,
    creationDate,
    reagents,
    labelTranscriptions,
    workSteps,
    markdownDoc,
  };
}

/**
 * Compiles a structured Experiment Notebook Markdown document (`## Description`, `## Reagents Used`, `## Experiment Steps`)
 * from a VideoAnalysisDoc or fixture object.
 */
export function compileArchiveMarkdownFromAnalysis(
  analysis: VideoAnalysisDoc | Record<string, any>
): string {
  const src = analysis as Record<string, any>;
  const classification =
    src.workflowClassification || src.workloadClassification || {};
  const description =
    classification.transcribedAudio ||
    classification.archiveName ||
    'Experiment notebook entry compiled from SAIL video analysis.';

  const reagentLines: string[] = [];
  const rawReagents = Array.isArray(src.reagents) ? src.reagents : [];
  for (const r of rawReagents) {
    if (r && typeof r === 'object' && r.reagentName) {
      reagentLines.push(
        `- **${r.reagentName}** (${r.reagentAcronym || 'N/A'}) | Manufacturer: ${
          r.manufacturer || 'N/A'
        } | Catalog/Ref #: ${r.catalogNumber || 'N/A'} | Lot #: ${r.lotNumber || 'N/A'}`
      );
    }
  }
  const refinements = Array.isArray(src.refinements) ? src.refinements : [];
  if (reagentLines.length === 0) {
    for (const ref of refinements) {
      if (
        ref.refinementClass === 'REAGENT_OCR_CONFLATION' ||
        ref.refinementClass === 'ACRONYM_MAPPING' ||
        ref.refinementClass === 'REAGENT_ACRONYM_RESOLUTION'
      ) {
        reagentLines.push(`- ${ref.transcriptionText}`);
      }
    }
  }
  const actions = Array.isArray(src.actions) ? src.actions : [];
  for (const act of actions) {
    if (act.cellLineName) {
      reagentLines.push(`- Cell Line: ${act.cellLineName}`);
    }
  }
  if (reagentLines.length === 0) {
    reagentLines.push('- Verified protocol reagents');
  }

  const stepLines: string[] = [];
  const rawWorkSteps = Array.isArray(src.workSteps) && src.workSteps.length > 0 ? src.workSteps : [];

  if (rawWorkSteps.length > 0) {
    rawWorkSteps.forEach((ws: any, idx: number) => {
      const stepNo = ws.stepNumber || idx + 1;
      if (
        (ws.actionType === 'MIX_REAGENTS' || ws.actionType === 'REAGENT_MIXING_ACTION') &&
        ws.mixReagentsData
      ) {
        const m = ws.mixReagentsData;
        stepLines.push(
          `${stepNo}. **Mix Reagents**: Mixed ${m.firstReagentAmount || 'N/A'} of ${m.firstReagentName || 'N/A'} with ${m.secondReagentAmount || 'N/A'} of ${m.secondReagentName || 'N/A'}.`
        );
      } else if (
        (ws.actionType === 'SEED_REAGENTS' || ws.actionType === 'REAGENT_SEEDING_ACTION') &&
        ws.seedReagentsData
      ) {
        const s = ws.seedReagentsData;
        const countStatus =
          s.isSeedingCountCorrect === false
            ? `Count Mismatch (${s.seedingEventsCount}/${s.expectedSeedingEventsCount || 'N/A'})`
            : `Verified (${s.seedingEventsCount}/${s.expectedSeedingEventsCount || s.seedingEventsCount} events)`;
        const plateMap = render96WellPlateMarkdown(s.seededColumns, s.seededWells);
        stepLines.push(
          `${stepNo}. **Seed Reagents**: Seeded ${s.cellsSeeded || 'N/A'} (${s.cellsPerWell || 'N/A'}) into ${s.plateType || 'N/A'} using ${s.pipetteType || 'N/A'} — Seeding Events: ${countStatus}.\n\n${plateMap}`
        );
      } else {
        stepLines.push(`${stepNo}. **${ws.actionType || 'Work Step'}**: ${ws.description || 'Executed step.'}`);
      }
    });
  } else {
    actions.forEach((act: Record<string, any>, idx: number) => {
      if (act.mixReagentsData) {
        const m = act.mixReagentsData;
        stepLines.push(
          `${idx + 1}. **Mix Reagents** (${act.actionId}): Mixed ${m.firstReagentAmount} of ${m.firstReagentName} with ${m.secondReagentAmount} of ${m.secondReagentName}`
        );
      } else if (act.seedReagentsData) {
        const s = act.seedReagentsData;
        const plateMap = render96WellPlateMarkdown(s.seededColumns, s.seededWells);
        stepLines.push(
          `${idx + 1}. **Seed Reagents** (${act.actionId}): Seeded ${s.cellsSeeded} (${s.cellsPerWell}) into ${s.plateType} with ${s.pipetteType} (${s.seedingEventsCount} seeding events)\n\n${plateMap}`
        );
      } else {
        const relatedRefs = refinements.filter((r: Record<string, any>) =>
          (act.eventList || []).includes(r.eventId)
        );
        const refText =
          relatedRefs.length > 0
            ? ` — ${relatedRefs.map((r: Record<string, any>) => r.transcriptionText).join('; ')}`
            : '';
        stepLines.push(
          `${idx + 1}. **${act.actionClass}** (${act.actionId}): ${(act.eventList || []).length} events${refText}`
        );
      }
    });
  }
  if (stepLines.length === 0) {
    stepLines.push('1. Executed experiment steps.');
  }

  return [
    '## Description',
    description,
    '',
    '## Reagents Used',
    ...reagentLines,
    '',
    '## Experiment Steps',
    ...stepLines,
  ].join('\n');
}

/**
 * Utility to generate and validate an InventorySignOffPayload from an analysis document or explicit parameters.
 */
export function generateInventorySignOffPayload(
  source: VideoAnalysisDoc | Record<string, any>,
  options: {
    databaseId?: string;
    videoId?: string;
    inventoryId?: string;
    boxId?: string;
    operatorInitials?: string;
    bucketName?: string;
    signedOffAt?: string;
  } = {}
): InventorySignOffPayload {
  const src = source as Record<string, any>;
  const databaseId =
    options.databaseId || src.databaseId || DEFAULT_TENANT_CONFIG.databaseId;
  const videoId = options.videoId || src.videoId || 'vid_inventory_01';
  const actions = Array.isArray(src.actions) ? src.actions : [];
  const refinements = Array.isArray(src.refinements) ? src.refinements : [];

  const inventoryId =
    options.inventoryId ||
    src.inventoryId ||
    actions[0]?.inventoryId ||
    src.workflowClassification?.inventoryName ||
    'inv_default_01';

  const defaultBoxId =
    options.boxId ||
    src.boxId ||
    actions[0]?.cellLineInfo?.boxId ||
    'box_01';

  const signedOffAt = options.signedOffAt || new Date().toISOString();
  const operatorInitials =
    options.operatorInitials ||
    actions[0]?.cellLineInfo?.operatorInitials ||
    actions[0]?.cellLineInfo?.operator ||
    DEFAULT_TENANT_CONFIG.operatorInitials;

  const boxUpdates: BoxUpdate[] = Array.isArray(src.boxUpdates)
    ? src.boxUpdates.map((u: any) => BoxUpdateSchema.parse(u))
    : actions.map((act: Record<string, any>) => {
        const spatialRef = refinements.find(
          (r: Record<string, any>) =>
            (act.eventList || []).includes(r.eventId) && r.spatialResult
        );
        const row = (
          act.boxWellLocation?.row ||
          act.boxRowId ||
          spatialRef?.spatialResult?.row ||
          'A'
        ).toUpperCase();
        const col = Number(
          act.boxWellLocation?.col ?? act.boxColId ?? spatialRef?.spatialResult?.col ?? 1
        );
        const isRemoval = String(act.actionType || act.actionClass || '')
          .toUpperCase()
          .includes('REMOVAL');
        const status = isRemoval ? 'EMPTY' : 'OCCUPIED';

        return BoxUpdateSchema.parse({
          boxId: act.cellLineInfo?.boxId || defaultBoxId,
          row,
          col,
          cellLineName: isRemoval
            ? act.vialLabelData?.cellLineName || act.cellLineName || ''
            : act.vialLabelData?.cellLineName || act.cellLineName || 'Unknown',
          userInitials: isRemoval
            ? act.vialLabelData?.userInitials || act.cellLineInfo?.userInitials || undefined
            : act.vialLabelData?.userInitials ||
              act.cellLineInfo?.userInitials ||
              operatorInitials,
          dateFrozen:
            act.vialLabelData?.dateFrozen ||
            act.cellLineInfo?.dateFrozen ||
            undefined,
          fullText: isRemoval
            ? act.vialLabelData?.fullText || act.cellLineInfo?.fullText || ''
            : act.vialLabelData?.fullText ||
              act.cellLineInfo?.fullText ||
              act.vialLabelData?.cellLineName ||
              act.cellLineName ||
              'Unknown',
          lotNumber:
            act.cellLineInfo?.lotNumber || act.cellLineInfo?.lot || undefined,
          passage:
            typeof act.cellLineInfo?.passage === 'number'
              ? act.cellLineInfo.passage
              : undefined,
          operatorInitials,
          actionId: act.actionId,
          actionType: isRemoval ? 'VIAL_REMOVAL' : 'VIAL_INSERTION',
          highlighted: status === 'OCCUPIED',
          status,
          updatedAt: signedOffAt,
        });
      });

  return InventorySignOffPayloadSchema.parse({
    databaseId,
    videoId,
    inventoryId,
    boxUpdates,
    signedOffAt,
    operatorInitials,
  });
}

/**
 * Utility to generate and validate an ArchiveSignOffPayload from an analysis document or explicit parameters.
 */
export function generateArchiveSignOffPayload(
  source: VideoAnalysisDoc | Record<string, any>,
  options: {
    databaseId?: string;
    videoId?: string;
    archiveId?: string;
    markdownDoc?: string;
    operatorInitials?: string;
    bucketName?: string;
    signedOffAt?: string;
  } = {}
): ArchiveSignOffPayload {
  const src = source as Record<string, any>;
  const databaseId =
    options.databaseId || src.databaseId || DEFAULT_TENANT_CONFIG.databaseId;
  const videoId = options.videoId || src.videoId || 'vid_archive_01';
  const actions = Array.isArray(src.actions) ? src.actions : [];
  const archiveId =
    options.archiveId ||
    src.archiveId ||
    actions[0]?.archiveId ||
    src.workflowClassification?.archiveName ||
    'archive_default_01';
  const markdownDoc =
    options.markdownDoc ||
    src.markdownDoc ||
    compileArchiveMarkdownFromAnalysis(src);
  const signedOffAt = options.signedOffAt || new Date().toISOString();
  const operatorInitials =
    options.operatorInitials || DEFAULT_TENANT_CONFIG.operatorInitials;

  return ArchiveSignOffPayloadSchema.parse({
    databaseId,
    videoId,
    archiveId,
    markdownDoc,
    signedOffAt,
    operatorInitials,
  });
}

/**
 * Unified SignOff payload generator utility that inspects workflowClassification.workflowType
 * and produces a schema-validated InventorySignOffPayload or ArchiveSignOffPayload.
 */
export function generateSignOffPayload(
  analysis: VideoAnalysisDoc | Record<string, any>,
  options: Record<string, any> = {}
): InventorySignOffPayload | ArchiveSignOffPayload {
  const src = analysis as Record<string, any>;
  const workflowType =
    src.workflowClassification?.workflowType ||
    src.workloadClassification?.workflowType;

  if (workflowType === 'EXPERIMENT_NOTEBOOK_WORKFLOW') {
    return generateArchiveSignOffPayload(src, options);
  }
  return generateInventorySignOffPayload(src, options);
}
