import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  compileArchiveMarkdownFromAnalysis,
  generateInventorySignOffPayload,
  generateArchiveSignOffPayload,
  generateSignOffPayload,
} from '../src/services/api.service.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const inventoryFixturePath = path.resolve(
  __dirname,
  '../../server/tests/fixtures/inventoryWorkflowFixture.json'
);
const archiveFixturePath = path.resolve(
  __dirname,
  '../../server/tests/fixtures/archiveWorkflowFixture.json'
);
const inventoryFixture = JSON.parse(fs.readFileSync(inventoryFixturePath, 'utf-8'));
const archiveFixture = JSON.parse(fs.readFileSync(archiveFixturePath, 'utf-8'));

describe('Phase 4 & 5: Atomic Sign-Off Payload Generator Utility & Multi-Tenant Scoping', () => {
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

  describe('3. SignOff Payload Generator Utilities (Inventory & Archive)', () => {
    it('should generate a valid InventorySignOffPayload from inventoryWorkflowFixture.json', () => {
      const payload = generateInventorySignOffPayload(inventoryFixture);
      const validated = InventorySignOffPayloadSchema.parse(payload);

      assert.strictEqual(validated.databaseId, 'customer-alpha-db');
      assert.strictEqual(validated.videoId, 'vid_inventory_fixture_01');
      assert.strictEqual(validated.inventoryId, 'inv_alpha_01');
      assert.strictEqual(validated.boxUpdates.length, 1);
      assert.strictEqual(validated.boxUpdates[0].boxId, 'box_01');
      assert.strictEqual(validated.boxUpdates[0].row, 'A');
      assert.strictEqual(validated.boxUpdates[0].col, 4);
      assert.strictEqual(validated.boxUpdates[0].cellLineName, 'HEK293T');
      assert.strictEqual(validated.boxUpdates[0].lotNumber, 'LOT-2026-A4');
      assert.strictEqual(validated.boxUpdates[0].passage, 4);
      assert.strictEqual(validated.boxUpdates[0].status, 'OCCUPIED');
    });

    it('should generate a valid ArchiveSignOffPayload from archiveWorkflowFixture.json', () => {
      const payload = generateArchiveSignOffPayload(archiveFixture);
      const validated = ArchiveSignOffPayloadSchema.parse(payload);

      assert.strictEqual(validated.databaseId, 'customer-alpha-db');
      assert.strictEqual(validated.videoId, 'vid_archive_fixture_02');
      assert.strictEqual(validated.archiveId, 'archive_exp_96well_01');
      assert.ok(validated.markdownDoc.includes('## Description'));
      assert.ok(validated.markdownDoc.includes('## Reagents Used'));
      assert.ok(validated.markdownDoc.includes('## Experiment Steps'));
      assert.ok(validated.markdownDoc.includes('FBS: Fetal Bovine Serum'));
      assert.ok(validated.markdownDoc.includes('100 µL / 3000 cells/well'));
    });

    it('should dispatch automatically via generateSignOffPayload based on workflowType', () => {
      const invPayload = generateSignOffPayload(inventoryFixture);
      assert.ok('boxUpdates' in invPayload);
      assert.strictEqual(invPayload.boxUpdates[0].row, 'A');
      assert.strictEqual(invPayload.boxUpdates[0].col, 4);

      const archPayload = generateSignOffPayload(archiveFixture);
      assert.ok('markdownDoc' in archPayload);
      assert.ok(archPayload.markdownDoc.includes('## Description'));
    });
  });

  describe('4. ApiService Atomic Sign-Off Assembly and Multi-Tenant Isolation', () => {
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
      assert.ok(
        res.documentPath.includes(
          '/databases/biolab-db-01/documents/inventories/tank_alpha_01/contents/box_03'
        )
      );
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

      const markdown = compileArchiveMarkdownFromAnalysis(SAMPLE_ARCHIVE_ANALYSIS);

      const res = await api.commitArchiveSignOff(
        'biolab-db-01',
        'vid_archive_demo_02',
        'archive_exp_402',
        markdown
      );

      assert.strictEqual(res.success, true);
      assert.ok(
        res.documentPath.includes('/databases/biolab-db-01/documents/archives/archive_exp_402')
      );
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
