/**
 * Spatial Coordinate Calculation Helpers:
 * Relates bounding boxes and spatial detections relative to the top-left origin:
 * Rows: A-Z
 * Columns: 1-N
 */

export function rowIndexToLetter(rowIndex: number): string {
  if (rowIndex < 0 || rowIndex > 25) {
    throw new RangeError(`Row index ${rowIndex} out of bounds (0-25)`);
  }
  return String.fromCharCode(65 + rowIndex);
}

export function letterToRowIndex(letter: string): number {
  if (!letter || typeof letter !== 'string') {
    throw new TypeError(`Invalid row letter: ${letter}`);
  }
  const code = letter.trim().toUpperCase().charCodeAt(0);
  if (code < 65 || code > 90) {
    throw new RangeError(`Invalid row letter: ${letter}`);
  }
  return code - 65;
}

/**
 * Computes grid coordinate (row A-Z, col 1-N) from normalized coordinates (0.0 - 1.0)
 * relative to the top-left origin.
 */
export function computeGridCoordinateFromNormalized(
  normX: number,
  normY: number,
  totalRows: number = 9,
  totalCols: number = 9
): { row: string; col: number } {
  const boundedX = Math.max(0, Math.min(0.9999, normX));
  const boundedY = Math.max(0, Math.min(0.9999, normY));

  const rowIndex = Math.floor(boundedY * totalRows);
  const colIndex = Math.floor(boundedX * totalCols) + 1;

  return {
    row: rowIndexToLetter(rowIndex),
    col: colIndex,
  };
}

/**
 * Computes cryo-box well coordinate (row A-Z starting at A for row 1, col 1-N starting at 1)
 * from normalized coordinates (0.0 - 1.0) where the origin (A1) is in the TOP-LEFT corner
 * (painted black on the physical box).
 * - normX = 0.0 is the left edge (column 1, black corner origin), normX = 1.0 is the right edge (column N)
 * - normY = 0.0 is the top edge (row A, black corner origin), normY = 1.0 is the bottom edge
 */
export function computeBoxWellFromTopLeftOrigin(
  normX: number,
  normY: number,
  totalRows: number = 9,
  totalCols: number = 9
): { row: string; col: number; coordinate: string; originCorner: 'TOP_LEFT_BLACK' } {
  const boundedX = Math.max(0, Math.min(0.9999, normX));
  const boundedY = Math.max(0, Math.min(0.9999, normY));

  const rowIndex = Math.floor(boundedY * totalRows);
  const colIndex = Math.floor(boundedX * totalCols) + 1;
  const row = rowIndexToLetter(rowIndex);

  return {
    row,
    col: colIndex,
    coordinate: `${row}${colIndex}`,
    originCorner: 'TOP_LEFT_BLACK',
  };
}

/**
 * Legacy helper maintained for backward compatibility, now delegates to TOP-LEFT origin (A1 at top-left black corner).
 */
export function computeBoxWellFromTopRightOrigin(
  normX: number,
  normY: number,
  totalRows: number = 9,
  totalCols: number = 9
): { row: string; col: number; coordinate: string; originCorner: 'TOP_LEFT_BLACK' } {
  return computeBoxWellFromTopLeftOrigin(normX, normY, totalRows, totalCols);
}

/**
 * Calculates row distance and column distance between two spatial coordinates.
 */
export function calculateSpatialDistance(
  coordA: { row: string; col: number },
  coordB: { row: string; col: number }
): { rowDiff: number; colDiff: number; euclidean: number } {
  const rowA = letterToRowIndex(coordA.row);
  const rowB = letterToRowIndex(coordB.row);
  const rowDiff = rowB - rowA;
  const colDiff = coordB.col - coordA.col;
  const euclidean = Math.sqrt(rowDiff * rowDiff + colDiff * colDiff);

  return { rowDiff, colDiff, euclidean };
}
