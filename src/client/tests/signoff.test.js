import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  BoxUpdateSchema,
  InventorySignOffPayloadSchema,
  ArchiveSignOffPayloadSchema,
  VideoAnalysisDocSchema,
} from '@sail/shared';

import {
  ApiService,
  DEFAULT_TENANT_CONFIG,
  SAMPLE_INVENTORY_ANALYSIS,
  SAMPLE_ARCHIVE_ANALYSIS,
} from '../src/services/api.service.ts';

describe('Phase 4: Atomic Sign-Off Payload Assembly & Multi-Tenant Scoping', () => {
  describe('1. Box Update and Inventory Sign-Off Schema Validation', () => {
    it('should validate a conforming BoxUpdateSchema item', () => {
      const validBoxUpdate = {
        boxId: 'box_01',
        row: 'C',
        col: 4,
        cellLineName: 'HEK293T',
        lotNumber: 'LOT-8841',
        passage: 5,
        operatorInitials: 'RS',
        status: 'OCCUPIED',
        updatedAt: new Date().toISOString(),
      };

      const parsed = BoxUpdateSchema.parse(validBoxUpdate);
      assert.strictEqual(parsed.boxId, 'box_01');
      assert.strictEqual(parsed.row, 'C');
      assert.strictEqual(parsed.col, 4);
      assert.strictEqual(parsed.cellLineName, 'HEK293T');
      assert.strictEqual(parsed.status, 'OCCUPIED');
    });

    it('should validate conforming InventorySignOffPayloadSchema', () => {
      const payload = {
        databaseId: 'customer-alpha-db',
        videoId: 'vid_cryo_demo_01',
        inventoryId: 'tank_alpha_01',
        boxUpdates: [
          {
            boxId: 'box_01',
            row: 'C',
            col: 4,
            cellLineName: 'HEK293T',
            lotNumber: 'LOT-8841',
            passage: 5,
            operatorInitials: 'RS',
            status: 'OCCUPIED',
            updatedAt: '2026-10-24T12:00:00.000Z',
          },
        ],
        signedOffAt: '2026-10-24T12:00:00.000Z',
        operatorInitials: 'RS',
      };

      const parsed = InventorySignOffPayloadSchema.parse(payload);
      assert.strictEqual(parsed.databaseId, 'customer-alpha-db');
      assert.strictEqual(parsed.videoId, 'vid_cryo_demo_01');
      assert.strictEqual(parsed.inventoryId, 'tank_alpha_01');
      assert.strictEqual(parsed.boxUpdates.length, 1);
      assert.strictEqual(parsed.boxUpdates[0].row, 'C');
      assert.strictEqual(parsed.boxUpdates[0].col, 4);
    });

    it('should reject invalid InventorySignOffPayload with missing required fields', () => {
      const invalid = {
        databaseId: 'test-db',
        // missing videoId and inventoryId
        boxUpdates: [],
      };
      assert.throws(() => InventorySignOffPayloadSchema.parse(invalid));
    });
  });

  describe('2. Archive Sign-Off Schema Validation & Markdown Compilation', () => {
    it('should validate conforming ArchiveSignOffPayloadSchema with required sections', () => {
      const markdownDoc = `## Description\nSeeded 96-well plate.\n\n## Reagents Used\n- DMEM 450 mL\n- FBS 50 mL\n\n## Experiment Steps\n1. Reconstitution\n2. Seeding`;

      const payload = {
        databaseId: 'customer-alpha-db',
        videoId: 'vid_archive_demo_02',
        archiveId: 'archive_exp_402',
        markdownDoc,
        signedOffAt: new Date().toISOString(),
        operatorInitials: 'RS',
      };

      const parsed = ArchiveSignOffPayloadSchema.parse(payload);
      assert.strictEqual(parsed.archiveId, 'archive_exp_402');
      assert.ok(parsed.markdownDoc.includes('## Description'));
      assert.ok(parsed.markdownDoc.includes('## Reagents Used'));
      assert.ok(parsed.markdownDoc.includes('## Experiment Steps'));
    });

    it('should reject invalid ArchiveSignOffPayload missing markdownDoc', () => {
      const invalid = {
        databaseId: 'customer-alpha-db',
        videoId: 'vid_123',
        archiveId: 'arch_1',
      };
      assert.throws(() => ArchiveSignOffPayloadSchema.parse(invalid));
    });
  });

  describe('3. ApiService Atomic Sign-Off Assembly and Multi-Tenant Isolation', () => {
    it('should construct atomic batch payload for commitInventorySignOff with tenant scoping', async () => {
      const api = new ApiService({
        tenant: {
          customerId: 'biolab-corp',
          databaseId: 'biolab-db-01',
          operatorInitials: 'RS',
        },
      });

      const boxUpdates = [
        {
          boxId: 'box_03',
          row: 'C',
          col: 4,
          cellLineName: 'HEK293T',
          lotNumber: 'LOT-8841',
          passage: 5,
          operatorInitials: 'RS',
          status: 'OCCUPIED',
        },
      ];

      const res = await api.commitInventorySignOff(
        'biolab-db-01',
        'vid_cryo_demo_01',
        'tank_alpha_01',
        boxUpdates
      );

      assert.strictEqual(res.success, true);
      assert.ok(res.documentPath.includes('/databases/biolab-db-01/documents/inventories/tank_alpha_01/contents/box_03'));
      assert.strictEqual(res.details.isSignedOff, true);
      assert.strictEqual(res.details.updatesCount, 1);
    });

    it('should construct atomic payload for commitArchiveSignOff with tenant scoping', async () => {
      const api = new ApiService({
        tenant: {
          customerId: 'biolab-corp',
          databaseId: 'biolab-db-01',
          operatorInitials: 'RS',
        },
      });

      const markdown = `## Description\nTested protocol.\n## Reagents Used\n- FBS\n## Experiment Steps\n1. Run`;

      const res = await api.commitArchiveSignOff(
        'biolab-db-01',
        'vid_archive_demo_02',
        'archive_exp_402',
        markdown
      );

      assert.strictEqual(res.success, true);
      assert.ok(res.documentPath.includes('/databases/biolab-db-01/documents/archives/archive_exp_402'));
      assert.strictEqual(res.details.isSignedOff, true);
      assert.strictEqual(res.details.archiveId, 'archive_exp_402');
    });

    it('should fetch and validate VideoAnalysisDoc conforming to VideoAnalysisDocSchema', async () => {
      const api = new ApiService({
        tenant: DEFAULT_TENANT_CONFIG,
      });

      const analysis = await api.fetchVideoAnalysis('vid_cryo_demo_01');
      const parsed = VideoAnalysisDocSchema.parse(analysis);

      assert.strictEqual(parsed.videoId, 'vid_cryo_demo_01');
      assert.ok(parsed.actions.length >= 1);
      assert.ok(parsed.events.length >= 1);
      assert.ok(parsed.refinements.length >= 1);
      assert.strictEqual(parsed.isSignedOff, false);
    });
  });
});
