const { describe, it } = require('node:test');
const assert = require('node:assert');

// Set test environment
process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT_ID = 'test-sail-project';

const { app } = require('../dist/server');
const {
  getFirestoreDb,
  updateVideoPass,
  getVideoPasses,
  getVideoMetadata,
} = require('../dist/services/firestore.service');
const {
  reconcileVideoInventoryAssociation,
} = require('../dist/controllers/pipeline.controller');

describe('Pass 0 Stale Error Reset & Inventory Association', () => {
  const databaseId = '(default)';
  const db = getFirestoreDb(databaseId);

  it('should reset error to null when pass status is COMPLETED', async () => {
    const videoId = 'vid_test_error_reset_' + Date.now();

    // 1. Initial state with an error
    await updateVideoPass(databaseId, videoId, 'pass0', {
      status: 'ERROR',
      error: 'archiveName: Expected string, received null',
    });

    let passInfo = await getVideoPasses(databaseId, videoId);
    assert.strictEqual(passInfo.passes.pass0.status, 'ERROR');
    assert.strictEqual(passInfo.passes.pass0.error, 'archiveName: Expected string, received null');

    // 2. Mark pass completed
    await updateVideoPass(databaseId, videoId, 'pass0', {
      status: 'COMPLETED',
      error: null,
      data: {
        workflowType: 'INVENTORY_UPDATE_WORKFLOW',
        inventoryName: 'Tank Alpha',
        transcribedAudio: 'Moving sample to Tank Alpha',
      },
    });

    passInfo = await getVideoPasses(databaseId, videoId);
    assert.strictEqual(passInfo.passes.pass0.status, 'COMPLETED');
    assert.strictEqual(passInfo.passes.pass0.error, null);
  });

  it('should automatically match and associate an inventory if name matches', async () => {
    const videoId = 'vid_test_auto_match_' + Date.now();
    const inventoryId = 'inv_tank_alpha_' + Date.now();

    // Create an inventory
    await db.collection('inventories').doc(inventoryId).set({
      id: inventoryId,
      name: 'Tank Alpha',
      createdAt: new Date().toISOString(),
    });

    // Run reconciliation with matching name (case-insensitive)
    const result = await reconcileVideoInventoryAssociation(databaseId, videoId, {
      workflowType: 'INVENTORY_UPDATE_WORKFLOW',
      inventoryName: 'tank alpha',
      transcribedAudio: 'Accessing tank alpha',
    });

    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.inventoryId, inventoryId);
    assert.strictEqual(result.inventoryName, 'Tank Alpha');

    const meta = await getVideoMetadata(databaseId, videoId);
    assert.strictEqual(meta.inventoryId, inventoryId);
    assert.strictEqual(meta.inventoryName, 'Tank Alpha');
    assert.strictEqual(meta.inventoryAssociationType, 'AUTOMATIC');
    assert.ok(meta.associatedAt);
  });

  it('should mark video as UNMATCHED if no inventory matches', async () => {
    const videoId = 'vid_test_unmatched_' + Date.now();

    const result = await reconcileVideoInventoryAssociation(databaseId, videoId, {
      workflowType: 'INVENTORY_UPDATE_WORKFLOW',
      inventoryName: 'Non-Existent Storage Unit 999',
      transcribedAudio: 'Opening unit 999',
    });

    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.inventoryId, null);

    const meta = await getVideoMetadata(databaseId, videoId);
    assert.strictEqual(meta.inventoryId, null);
    assert.strictEqual(meta.unmatchedInventoryName, 'Non-Existent Storage Unit 999');
    assert.strictEqual(meta.inventoryAssociationType, 'UNMATCHED');
  });

  it('should support manual association via POST /api/videos/:videoId/associate-inventory', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const videoId = 'vid_test_manual_assoc_' + Date.now();
      const inventoryId = 'inv_target_' + Date.now();

      // Create target inventory
      await db.collection('inventories').doc(inventoryId).set({
        id: inventoryId,
        name: 'Cryo-Freezer Beta',
        createdAt: new Date().toISOString(),
      });

      // Call endpoint
      const res = await fetch(`http://localhost:${port}/api/videos/${videoId}/associate-inventory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventoryId }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.inventoryId, inventoryId);
      assert.strictEqual(data.inventoryName, 'Cryo-Freezer Beta');
      assert.strictEqual(data.video.inventoryId, inventoryId);
      assert.strictEqual(data.video.inventoryAssociationType, 'MANUAL');

      // Verify persisted in Firestore
      const meta = await getVideoMetadata(databaseId, videoId);
      assert.strictEqual(meta.inventoryId, inventoryId);
      assert.strictEqual(meta.inventoryName, 'Cryo-Freezer Beta');
      assert.strictEqual(meta.inventoryAssociationType, 'MANUAL');
    } finally {
      server.close();
    }
  });
});
