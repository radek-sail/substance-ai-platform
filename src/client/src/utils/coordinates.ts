/**
 * Coordinate conversion and validation utilities for Cryo-Box (9x9) and Microplate (96-well, 8x12) matrix grids.
 * Enforces top-left origin:
 * - Rows: Alphabetical descending (A=1 / index 0, B=2 / index 1, C=3 / index 2...)
 * - Columns: Numerical horizontal (1, 2, 3...)
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
 * Converts a row letter to 1-based descending row number from top-left origin (A=1, B=2, C=3...).
 */
export function letterToRowNumber(letter: string): number {
  return letterToRowIndex(letter) + 1;
}

/**
 * Converts a 1-based row number (1=A, 2=B, 3=C...) to uppercase row letter.
 */
export function rowNumberToLetter(rowNumber: number): string {
  if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 26) {
    throw new RangeError(`Row number ${rowNumber} out of bounds (1-26)`);
  }
  return rowIndexToLetter(rowNumber - 1);
}

/**
 * Maps a coordinate (e.g., "A4" or ("A", 4)) to its 1-based top-left origin numeric indices:
 * rowNumber (A=1, B=2...), col (1, 2, 3...), and 0-based indices.
 */
export function toTopLeftGridPosition(
  rowOrCoord: string,
  col?: number
): {
  row: string;
  rowNumber: number;
  rowIndex: number;
  col: number;
  colIndex: number;
  coordinate: string;
} {
  let resolvedRow: string;
  let resolvedCol: number;

  if (typeof col === 'number') {
    resolvedRow = rowOrCoord.trim().toUpperCase();
    resolvedCol = col;
  } else {
    const parsed = parseCoordinate(rowOrCoord);
    if (!parsed) {
      throw new RangeError(`Invalid coordinate string: ${rowOrCoord}`);
    }
    resolvedRow = parsed.row;
    resolvedCol = parsed.col;
  }

  if (!Number.isInteger(resolvedCol) || resolvedCol < 1) {
    throw new RangeError(`Column ${resolvedCol} must be a positive integer >= 1`);
  }

  const rowIndex = letterToRowIndex(resolvedRow);
  const rowNumber = rowIndex + 1;

  return {
    row: resolvedRow,
    rowNumber,
    rowIndex,
    col: resolvedCol,
    colIndex: resolvedCol - 1,
    coordinate: `${resolvedRow}${resolvedCol}`,
  };
}

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

export function formatCoordinate(row: string, col: number): string {
  return `${row.toUpperCase()}${col}`;
}

export function parseCoordinate(coordStr: string): { row: string; col: number } | null {
  if (!coordStr || typeof coordStr !== 'string') return null;
  const match = coordStr.trim().toUpperCase().match(/^([A-Z])(\d+)$/);
  if (!match) return null;
  return {
    row: match[1],
    col: parseInt(match[2], 10),
  };
}

export interface MicroplateSeedingValidationResult {
  isFullySeeded: boolean;
  seededColumns: number[];
  missingColumns: number[];
  totalColumnsVerified: number;
  totalWellsSeeded: number;
}

/**
 * Validates 96-well microplate (8 rows A-H x 12 columns 1-12) seeding completeness.
 * Confirms whether all 12 columns (1..12) have been verified as seeded.
 */
export function validateMicroplateSeeding(
  input:
    | number[]
    | string[]
    | Array<Record<string, any>>
    | {
        seededColumns?: number[];
        actions?: Array<Record<string, any>>;
        events?: Array<Record<string, any>>;
        refinements?: Array<Record<string, any>>;
      }
): MicroplateSeedingValidationResult {
  const columnSet = new Set<number>();

  const addColumnIfValid = (colNum: number) => {
    if (Number.isInteger(colNum) && colNum >= 1 && colNum <= 12) {
      columnSet.add(colNum);
    }
  };

  if (Array.isArray(input)) {
    input.forEach((item, index) => {
      if (typeof item === 'number') {
        addColumnIfValid(item);
      } else if (typeof item === 'string') {
        const coord = parseCoordinate(item);
        if (coord) {
          addColumnIfValid(coord.col);
        } else {
          const colMatch = item.match(/col[_-]?0?(\d{1,2})/i);
          if (colMatch) {
            addColumnIfValid(parseInt(colMatch[1], 10));
          }
        }
      } else if (item && typeof item === 'object') {
        if (typeof item.col === 'number') {
          addColumnIfValid(item.col);
        }
        if (typeof item.boxColId === 'number') {
          addColumnIfValid(item.boxColId);
        }
        if (typeof item.eventId === 'string') {
          const colMatch = item.eventId.match(/col[_-]?0?(\d{1,2})/i);
          if (colMatch) {
            addColumnIfValid(parseInt(colMatch[1], 10));
          } else if (item.eventClass === 'POST_TRANSFER_STATE_EVENT') {
            addColumnIfValid(index + 1);
          }
        }
      }
    });
  } else if (input && typeof input === 'object') {
    if (Array.isArray(input.seededColumns)) {
      input.seededColumns.forEach(addColumnIfValid);
    }
    if (Array.isArray(input.actions)) {
      for (const act of input.actions) {
        if (Array.isArray(act.cellLineInfo?.seededColumns)) {
          act.cellLineInfo.seededColumns.forEach(addColumnIfValid);
        }
        if (Array.isArray(act.eventList) && act.actionClass === 'REAGENT_SEEDING_ACTION') {
          act.eventList.forEach((evtId: string, idx: number) => {
            const match = String(evtId).match(/col[_-]?0?(\d{1,2})/i);
            if (match) {
              addColumnIfValid(parseInt(match[1], 10));
            } else if (act.eventList.length === 12) {
              addColumnIfValid(idx + 1);
            }
          });
        }
      }
    }
    if (Array.isArray(input.events)) {
      const seedingEvents = input.events.filter(
        (e) =>
          e.eventClass === 'POST_TRANSFER_STATE_EVENT' ||
          String(e.eventId || '').includes('seed')
      );
      seedingEvents.forEach((evt, idx) => {
        const match = String(evt.eventId || '').match(/col[_-]?0?(\d{1,2})/i);
        if (match) {
          addColumnIfValid(parseInt(match[1], 10));
        } else if (seedingEvents.length === 12) {
          addColumnIfValid(idx + 1);
        }
      });
    }
  }

  const allColumns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const seededColumns = Array.from(columnSet).sort((a, b) => a - b);
  const missingColumns = allColumns.filter((c) => !columnSet.has(c));

  return {
    isFullySeeded: seededColumns.length === 12 && missingColumns.length === 0,
    seededColumns,
    missingColumns,
    totalColumnsVerified: seededColumns.length,
    totalWellsSeeded: seededColumns.length * 8,
  };
}
