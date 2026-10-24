import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  rowIndexToLetter,
  letterToRowIndex,
  computeGridCoordinateFromNormalized,
  calculateSpatialDistance,
  formatCoordinate,
  parseCoordinate,
} from '../src/utils/coordinates.ts';

describe('Phase 4: Client Coordinate Utilities & Top-Left Box Origin', () => {
  describe('Row Index and Letter Conversions', () => {
    it('should accurately convert zero-based row indices to uppercase letters (A-Z)', () => {
      assert.strictEqual(rowIndexToLetter(0), 'A');
      assert.strictEqual(rowIndexToLetter(1), 'B');
      assert.strictEqual(rowIndexToLetter(2), 'C');
      assert.strictEqual(rowIndexToLetter(8), 'I');
      assert.strictEqual(rowIndexToLetter(25), 'Z');
      assert.throws(() => rowIndexToLetter(-1), RangeError);
      assert.throws(() => rowIndexToLetter(26), RangeError);
    });

    it('should accurately convert row letters (A-Z) to zero-based row indices', () => {
      assert.strictEqual(letterToRowIndex('A'), 0);
      assert.strictEqual(letterToRowIndex('b'), 1);
      assert.strictEqual(letterToRowIndex('C'), 2);
      assert.strictEqual(letterToRowIndex('I'), 8);
      assert.strictEqual(letterToRowIndex('Z'), 25);
      assert.throws(() => letterToRowIndex('1'), RangeError);
      assert.throws(() => letterToRowIndex('!'), RangeError);
      assert.throws(() => letterToRowIndex(''), TypeError);
    });
  });

  describe('Top-Left Origin Normalized Coordinate Mapping', () => {
    it('should map (0.05, 0.05) to top-left slot A1 for 9x9 cryo-box', () => {
      const topLeft = computeGridCoordinateFromNormalized(0.05, 0.05, 9, 9);
      assert.strictEqual(topLeft.row, 'A');
      assert.strictEqual(topLeft.col, 1);
    });

    it('should map (0.95, 0.95) to bottom-right slot I9 for 9x9 cryo-box', () => {
      const bottomRight = computeGridCoordinateFromNormalized(0.95, 0.95, 9, 9);
      assert.strictEqual(bottomRight.row, 'I');
      assert.strictEqual(bottomRight.col, 9);
    });

    it('should map (0.5, 0.5) to center slot E5 for 9x9 cryo-box', () => {
      const center = computeGridCoordinateFromNormalized(0.5, 0.5, 9, 9);
      assert.strictEqual(center.row, 'E');
      assert.strictEqual(center.col, 5);
    });

    it('should map normalized box coordinates to slot C4 (target coordinate)', () => {
      // Slot C4: row C is index 2 (2/9 approx 0.222..0.333), col 4 is (3/9 approx 0.333..0.444)
      const coordC4 = computeGridCoordinateFromNormalized(0.38, 0.28, 9, 9);
      assert.strictEqual(coordC4.row, 'C');
      assert.strictEqual(coordC4.col, 4);
    });

    it('should map 8x12 96-well microplate normalized coordinates (A-H, 1-12)', () => {
      // Top-left: A1
      const wellA1 = computeGridCoordinateFromNormalized(0.02, 0.02, 8, 12);
      assert.strictEqual(wellA1.row, 'A');
      assert.strictEqual(wellA1.col, 1);

      // Bottom-right: H12
      const wellH12 = computeGridCoordinateFromNormalized(0.98, 0.98, 8, 12);
      assert.strictEqual(wellH12.row, 'H');
      assert.strictEqual(wellH12.col, 12);

      // Well C4: row C is index 2 (2/8 = 0.25..0.375), col 4 is (3/12 = 0.25..0.333)
      const wellC4 = computeGridCoordinateFromNormalized(0.29, 0.31, 8, 12);
      assert.strictEqual(wellC4.row, 'C');
      assert.strictEqual(wellC4.col, 4);
    });
  });

  describe('Spatial Distance & Differencing', () => {
    it('should calculate spatial delta and Euclidean distance between two coordinates', () => {
      const coordA = { row: 'A', col: 1 };
      const coordB = { row: 'C', col: 4 }; // Row A->C (+2), Col 1->4 (+3)
      const diff = calculateSpatialDistance(coordA, coordB);
      assert.strictEqual(diff.rowDiff, 2);
      assert.strictEqual(diff.colDiff, 3);
      assert.strictEqual(diff.euclidean, Math.sqrt(4 + 9));
    });

    it('should compute zero distance for identical coordinates', () => {
      const diff = calculateSpatialDistance({ row: 'C', col: 4 }, { row: 'C', col: 4 });
      assert.strictEqual(diff.rowDiff, 0);
      assert.strictEqual(diff.colDiff, 0);
      assert.strictEqual(diff.euclidean, 0);
    });
  });

  describe('String Formatting and Parsing', () => {
    it('should format row and column into coordinate string', () => {
      assert.strictEqual(formatCoordinate('c', 4), 'C4');
      assert.strictEqual(formatCoordinate('a', 1), 'A1');
      assert.strictEqual(formatCoordinate('h', 12), 'H12');
    });

    it('should parse coordinate strings into structured row and column objects', () => {
      const c4 = parseCoordinate('C4');
      assert.deepStrictEqual(c4, { row: 'C', col: 4 });

      const h12 = parseCoordinate('h12');
      assert.deepStrictEqual(h12, { row: 'H', col: 12 });

      assert.strictEqual(parseCoordinate('INVALID'), null);
      assert.strictEqual(parseCoordinate(''), null);
    });
  });
});
