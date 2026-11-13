import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildArchiveNotebookPdfBytes } from '../src/components/archive/ExperimentArchive.tsx';

describe('Archive Notebook PDF Generation', () => {
  it('should render seeded wells and empty wells visibly in the 96-well plate visualization', () => {
    const pdfBytes = buildArchiveNotebookPdfBytes({
      archiveId: 'arch_test_96well',
      archiveName: 'Experiment Exp-402 Seeding Verification',
      creatorName: 'Lab Operator',
      creationDate: '2026-11-12',
      purpose: 'Verifying 96-well plate seeding PDF visualization',
      reagents: [
        {
          reagentName: 'Dulbecco Modified Eagle Medium',
          reagentAcronym: 'DMEM',
          manufacturer: 'Gibco',
          catalogNumber: '11965092',
          lotNumber: '2458911',
        },
      ],
      workSteps: [
        {
          stepId: 'step_seed_01',
          actionType: 'SEED_REAGENTS',
          description: 'Seeding A549 cells into 96-well plate',
          startTime: '00:10',
          endTime: '00:45',
          seedReagentsData: {
            plateType: '96-well plate',
            pipetteType: '8-channel pipette',
            cellsSeeded: 'A549',
            cellsPerWell: '3K cells/well',
            seedingEventsCount: 3,
            expectedSeedingEventsCount: 12,
            seededColumns: [1, 2, 3],
            seededWells: [
              'A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1',
              'A2', 'B2', 'C2', 'D2', 'E2', 'F2', 'G2', 'H2',
              'A3', 'B3', 'C3', 'D3', 'E3', 'F3', 'G3', 'H3',
            ],
          },
        },
      ],
    });

    assert.ok(pdfBytes instanceof Uint8Array, 'Must return Uint8Array');
    assert.ok(pdfBytes.length > 500, 'PDF must contain content');

    const pdfString = Buffer.from(pdfBytes).toString('utf-8');
    assert.ok(pdfString.startsWith('%PDF-1.4'), 'Must be valid PDF-1.4 header');
    assert.ok(pdfString.includes('%%EOF'), 'Must contain PDF EOF trailer');

    // Title line must have clean hyphen (not stripped en-dash)
    assert.ok(
      pdfString.includes('96-Well Plate Map \\(Rows A-H, Columns 1-12 Left to Right\\):'),
      'Must contain properly formatted plate map title'
    );

    // Plate rows must contain seeded wells marked with 'X' and empty wells marked with '.'
    assert.ok(
      pdfString.includes('A |  X  X  X  .  .  .  .  .  .  .  .  . |'),
      'Row A must visibly display seeded wells as X and empty wells as .'
    );
    assert.ok(
      pdfString.includes('H |  X  X  X  .  .  .  .  .  .  .  .  . |'),
      'Row H must visibly display seeded wells as X and empty wells as .'
    );

    // Legend must reflect seeded (X) and empty (.) markers
    assert.ok(
      pdfString.includes('Legend: X = Seeded \\(24/96 wells across 3/12 columns\\) | . = Empty'),
      'Legend must map X to Seeded and . to Empty without blank characters'
    );

    // Ensure neither character is blank in the grid
    assert.ok(
      !pdfString.includes('A |                                      |'),
      'Grid row must NOT be blank'
    );
    assert.ok(
      !pdfString.includes('Legend:   = Seeded'),
      'Legend seeded symbol must NOT be blank'
    );
    assert.ok(
      !pdfString.includes('|   = Empty'),
      'Legend empty symbol must NOT be blank'
    );
  });
});
