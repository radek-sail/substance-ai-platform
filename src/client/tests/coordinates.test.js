import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  rowIndexToLetter,
  letterToRowIndex,
  letterToRowNumber,
  rowNumberToLetter,
  toTopLeftGridPosition,
  computeGridCoordinateFromNormalized,
  calculateSpatialDistance,
  formatCoordinate,
  parseCoordinate,
  validateMicroplateSeeding,
} from '../src/utils/coordinates.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const archiveFixturePath = path.resolve(
  __dirname,
  '../../server/tests/fixtures/archiveWorkflowFixture.json'
);
const archiveFixture = JSON.parse(fs.readFileSync(archiveFixturePath, 'utf-8'));

describe('Phase 4 & 5: Client Coordinate Transformation & 96-Well Seeding Validator', () => {
  describe('Row Index, Row Number (1-Based A=1, B=2...) and Letter Conversions', () => {
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

    it('should map top-left origin with row descending alphabetical (A=1, B=2...) and column horizontal (1, 2, 3...)', () => {
      assert.strictEqual(letterToRowNumber('A'), 1);
      assert.strictEqual(letterToRowNumber('B'), 2);
      assert.strictEqual(letterToRowNumber('C'), 3);
      assert.strictEqual(letterToRowNumber('H'), 8);
      assert.strictEqual(letterToRowNumber('I'), 9);

      assert.strictEqual(rowNumberToLetter(1), 'A');
      assert.strictEqual(rowNumberToLetter(2), 'B');
      assert.strictEqual(rowNumberToLetter(8), 'H');
      assert.strictEqual(rowNumberToLetter(9), 'I');

      const posA4 = toTopLeftGridPosition('A4');
      assert.strictEqual(posA4.row, 'A');
      assert.strictEqual(posA4.rowNumber, 1);
      assert.strictEqual(posA4.col, 4);
      assert.strictEqual(posA4.coordinate, 'A4');

      const posB2 = toTopLeftGridPosition('B', 2);
      assert.strictEqual(posB2.row, 'B');
      assert.strictEqual(posB2.rowNumber, 2);
      assert.strictEqual(posB2.col, 2);
      assert.strictEqual(posB2.coordinate, 'B2');
    });
  });

  describe('Top-Left Origin Normalized Coordinate Mapping', () => {
    it('should map (0.05, 0.05) to top-left slot A1 for 9x9 cryo-box', () => {
      const topLeft = computeGridCoordinateFromNormalized(0.05, 0.05, 9, 9);
      assert.strictEqual(topLeft.row, 'A');
      assert.strictEqual(topLeft.col, 1);
    });

    it('should map normalized coordinates to slot A4 for 9x9 cryo-box', () => {
      const slotA4 = computeGridCoordinateFromNormalized(0.38, 0.05, 9, 9);
      assert.strictEqual(slotA4.row, 'A');
      assert.strictEqual(slotA4.col, 4);
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
      const coordC4 = computeGridCoordinateFromNormalized(0.38, 0.28, 9, 9);
      assert.strictEqual(coordC4.row, 'C');
      assert.strictEqual(coordC4.col, 4);
    });

    it('should map 8x12 96-well microplate normalized coordinates (A-H, 1-12)', () => {
      const wellA1 = computeGridCoordinateFromNormalized(0.02, 0.02, 8, 12);
      assert.strictEqual(wellA1.row, 'A');
      assert.strictEqual(wellA1.col, 1);

      const wellH12 = computeGridCoordinateFromNormalized(0.98, 0.98, 8, 12);
      assert.strictEqual(wellH12.row, 'H');
      assert.strictEqual(wellH12.col, 12);

      const wellC4 = computeGridCoordinateFromNormalized(0.29, 0.31, 8, 12);
      assert.strictEqual(wellC4.row, 'C');
      assert.strictEqual(wellC4.col, 4);
    });
  });

  describe('Spatial Distance & Differencing', () => {
    it('should calculate spatial delta and Euclidean distance between two coordinates', () => {
      const coordA = { row: 'A', col: 1 };
      const coordB = { row: 'C', col: 4 };
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
      assert.strictEqual(formatCoordinate('a', 4), 'A4');
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

  describe('Microplate 96-Well Seeding Validator (12 Columns)', () => {
    it('should confirm all 12 columns are verified as seeded from archiveWorkflowFixture.json', () => {
      const validation = validateMicroplateSeeding(archiveFixture);
      assert.strictEqual(validation.isFullySeeded, true);
      assert.strictEqual(validation.totalColumnsVerified, 12);
      assert.strictEqual(validation.totalWellsSeeded, 96);
      assert.deepStrictEqual(validation.seededColumns, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      assert.deepStrictEqual(validation.missingColumns, []);
    });

    it('should confirm all 12 columns when passed the 12 seeding events directly', () => {
      const seedingEvents = archiveFixture.events.filter(
        (e) => e.actionId === 'act_arch_002'
      );
      const validation = validateMicroplateSeeding(seedingEvents);
      assert.strictEqual(validation.isFullySeeded, true);
      assert.strictEqual(validation.totalColumnsVerified, 12);
      assert.strictEqual(validation.totalWellsSeeded, 96);
    });

    it('should detect missing columns when fewer than 12 columns are seeded', () => {
      const partialValidation = validateMicroplateSeeding([1, 2, 3, 4, 5, 6]);
      assert.strictEqual(partialValidation.isFullySeeded, false);
      assert.strictEqual(partialValidation.totalColumnsVerified, 6);
      assert.strictEqual(partialValidation.totalWellsSeeded, 48);
      assert.deepStrictEqual(partialValidation.missingColumns, [7, 8, 9, 10, 11, 12]);
    });
  });
});
