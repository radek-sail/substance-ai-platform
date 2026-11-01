const { describe, it } = require('node:test');
const assert = require('node:assert');

// Set test environment
process.env.NODE_ENV = 'test';
process.env.FIREBASE_PROJECT_ID = 'test-sail-project';

const {
  generateInventoryBoxes,
  createDefaultDemoInventory,
} = require('../dist/controllers/inventory.controller');
const { app } = require('../dist/server');

describe('Multi-Inventory Management & Endpoints', () => {
  it('should generate correct tower and box labels and initialized cells', () => {
    const boxes = generateInventoryBoxes(3, 4, 9, 9);
    // 3 towers * 4 boxes = 12 boxes
    assert.strictEqual(Object.keys(boxes).length, 12);

    // Towers: A, B, C
    assert.ok(boxes['A-1']);
    assert.ok(boxes['A-4']);
    assert.ok(boxes['B-1']);
    assert.ok(boxes['C-4']);
    assert.strictEqual(boxes['D-1'], undefined);

    const boxA1 = boxes['A-1'];
    assert.strictEqual(boxA1.boxId, 'A-1');
    assert.strictEqual(boxA1.towerLabel, 'A');
    assert.strictEqual(boxA1.boxNumber, 1);
    assert.strictEqual(boxA1.rows, 9);
    assert.strictEqual(boxA1.cols, 9);
    assert.strictEqual(Object.keys(boxA1.cells).length, 81);

    const cellA1 = boxA1.cells['A1'];
    assert.strictEqual(cellA1.row, 'A');
    assert.strictEqual(cellA1.col, 1);
    assert.strictEqual(cellA1.cellCoordinate, 'A1');
    assert.strictEqual(cellA1.occupied, false);

    const cellI9 = boxA1.cells['I9'];
    assert.strictEqual(cellI9.row, 'I');
    assert.strictEqual(cellI9.col, 9);
    assert.strictEqual(cellI9.cellCoordinate, 'I9');
    assert.strictEqual(cellI9.occupied, false);
  });

  it('should return demo inventory on first GET /api/inventories when collection is empty', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/inventories`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.inventories));
      assert.ok(data.inventories.length >= 1);
      const first = data.inventories[0];
      assert.ok(first.id);
      assert.ok(first.name);
      assert.ok(first.boxes);
    } finally {
      server.close();
    }
  });

  it('should validate parameters on POST /api/inventories', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      // Missing name
      const res1 = await fetch(`http://localhost:${port}/api/inventories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          towersCount: 2,
          boxesPerTower: 3,
          rowsPerBox: 9,
          colsPerBox: 9,
        }),
      });
      assert.strictEqual(res1.status, 400);

      // towersCount > 26
      const res2 = await fetch(`http://localhost:${port}/api/inventories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid Tank',
          towersCount: 30,
          boxesPerTower: 3,
          rowsPerBox: 9,
          colsPerBox: 9,
        }),
      });
      assert.strictEqual(res2.status, 400);

      // rowsPerBox < 1
      const res3 = await fetch(`http://localhost:${port}/api/inventories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid Tank',
          towersCount: 2,
          boxesPerTower: 3,
          rowsPerBox: 0,
          colsPerBox: 9,
        }),
      });
      assert.strictEqual(res3.status, 400);
    } finally {
      server.close();
    }
  });

  it('should create new inventory with customizable dimensions via POST /api/inventories', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      const payload = {
        name: 'Cryo Tank Gamma',
        towersCount: 4,
        boxesPerTower: 3,
        rowsPerBox: 10,
        colsPerBox: 10,
      };

      const res = await fetch(`http://localhost:${port}/api/inventories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.strictEqual(res.status, 201);
      const created = await res.json();
      assert.ok(created.id);
      assert.strictEqual(created.name, 'Cryo Tank Gamma');
      assert.strictEqual(created.towersCount, 4);
      assert.strictEqual(created.boxesPerTower, 3);
      assert.strictEqual(created.rowsPerBox, 10);
      assert.strictEqual(created.colsPerBox, 10);
      assert.strictEqual(Object.keys(created.boxes).length, 12);
      assert.ok(created.boxes['D-3']);

      // Verify GET /api/inventories/:id
      const getRes = await fetch(`http://localhost:${port}/api/inventories/${created.id}`);
      assert.strictEqual(getRes.status, 200);
      const fetched = await getRes.json();
      assert.strictEqual(fetched.id, created.id);
      assert.strictEqual(fetched.name, 'Cryo Tank Gamma');

      // Verify GET /api/inventories lists this inventory
      const listRes = await fetch(`http://localhost:${port}/api/inventories`);
      assert.strictEqual(listRes.status, 200);
      const listData = await listRes.json();
      const match = listData.inventories.find((inv) => inv.id === created.id);
      assert.ok(match);
    } finally {
      server.close();
    }
  });

  it('should update a specific cell via PATCH /api/inventories/:id/cells', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    try {
      // Create inventory first
      const createRes = await fetch(`http://localhost:${port}/api/inventories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Cell Update Test Tank',
          towersCount: 2,
          boxesPerTower: 2,
          rowsPerBox: 9,
          colsPerBox: 9,
        }),
      });
      const created = await createRes.json();

      // Update slot A-1 cell C4
      const patchRes = await fetch(`http://localhost:${port}/api/inventories/${created.id}/cells`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boxId: 'A-1',
          cellCoordinate: 'C4',
          occupied: true,
          vial: {
            cellLineIdentifier: 'HEK293-TEST',
            lotNumber: 'LOT-999',
            passageNumber: 3,
            notes: 'Stored via UI inspection test',
          },
        }),
      });
      assert.strictEqual(patchRes.status, 200);
      const patchData = await patchRes.json();
      assert.strictEqual(patchData.success, true);
      assert.strictEqual(patchData.cell.cellCoordinate, 'C4');
      assert.strictEqual(patchData.cell.occupied, true);
      assert.strictEqual(patchData.cell.vial.cellLineIdentifier, 'HEK293-TEST');

      // Fetch inventory again to verify persistence
      const getRes = await fetch(`http://localhost:${port}/api/inventories/${created.id}`);
      const fetched = await getRes.json();
      assert.strictEqual(fetched.boxes['A-1'].cells['C4'].occupied, true);
      assert.strictEqual(fetched.boxes['A-1'].cells['C4'].vial.cellLineIdentifier, 'HEK293-TEST');
    } finally {
      server.close();
    }
  });
});
