import { z } from 'zod';

const STOP_WORDS = new Set([
  'and',
  'of',
  'in',
  'with',
  'for',
  'the',
  'at',
  'to',
  'by',
  'from',
  'or',
  'a',
  'an',
  'without',
  'plus',
]);

const UNIT_OR_CONCENTRATION_TOKEN =
  /^\d+(\.\d+)?(%|x|ml|l|ul|µl|ug|µg|mg|g|kg|m|mm|um|µm|nm|iu|u)?$/i;

const KNOWN_REAGENT_SYNONYMS: Array<{ acronym: string; aliases: string[]; fullName: string }> = [
  {
    acronym: 'FBS',
    aliases: ['FBS', 'HI-FBS'],
    fullName: 'Fetal Bovine Serum',
  },
  {
    acronym: 'DMEM',
    aliases: ['DMEM', 'D-MEM'],
    fullName: "Dulbecco's Modified Eagle Medium",
  },
  {
    acronym: 'DPBS',
    aliases: ['DPBS', 'D-PBS'],
    fullName: "Dulbecco's Phosphate Buffered Saline",
  },
  {
    acronym: 'PBS',
    aliases: ['PBS'],
    fullName: 'Phosphate Buffered Saline',
  },
  {
    acronym: 'PS',
    aliases: ['PS', 'P/S', 'PEN-STREP', 'PEN/STREP', 'PENSTREP'],
    fullName: 'Penicillin-Streptomycin',
  },
  {
    acronym: 'RPMI',
    aliases: ['RPMI', 'RPMI-1640', 'RPMI1640', 'RPMI 1640'],
    fullName: 'RPMI 1640 Medium',
  },
  {
    acronym: 'MEM',
    aliases: ['MEM'],
    fullName: 'Minimum Essential Medium',
  },
  {
    acronym: 'HBSS',
    aliases: ['HBSS'],
    fullName: "Hanks' Balanced Salt Solution",
  },
  {
    acronym: 'BSA',
    aliases: ['BSA'],
    fullName: 'Bovine Serum Albumin',
  },
  {
    acronym: 'DMSO',
    aliases: ['DMSO'],
    fullName: 'Dimethyl Sulfoxide',
  },
  {
    acronym: 'TE',
    aliases: ['TE', 'TRYPSIN-EDTA'],
    fullName: 'Trypsin-EDTA',
  },
];

const KNOWN_MANUFACTURERS = [
  'Thermo Fisher Scientific',
  'Thermo Fisher',
  'Fisher Scientific',
  'Sigma-Aldrich',
  'MilliporeSigma',
  'STEMCELL Technologies',
  'New England Biolabs',
  'BD Biosciences',
  'R&D Systems',
  'Miltenyi Biotec',
  'Pan-Biotech',
  'Gibco',
  'Invitrogen',
  'Corning',
  'Lonza',
  'HyClone',
  'Cytiva',
  'BioLegend',
  'ATCC',
  'Promega',
  'Takara',
  'Abcam',
  'Bio-Rad',
  'VWR',
  'Mediatech',
  'Cellgro',
  'Biowest',
  'PeproTech',
  'Merck',
  'Sigma',
  'NEB',
];

function normalizeAlphaNum(value?: string | null): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
}

/**
 * Generates an uppercase acronym from the first letters of the words in a reagent name.
 * Example: "Fetal Bovine Serum" -> "FBS"
 * Example: "Dulbecco's Modified Eagle Medium" -> "DMEM"
 * Example: "Penicillin-Streptomycin" -> "PS"
 * If the name is already a short uppercase acronym (e.g. "FBS", "DMEM", "PBS"), returns it as-is.
 */
export function generateReagentAcronym(reagentName?: string | null): string {
  const trimmed = String(reagentName || '').trim();
  if (!trimmed || trimmed.toUpperCase() === 'N/A') {
    return 'N/A';
  }

  // Check if parenthetical explicitly contains a short uppercase acronym, e.g., "Fetal Bovine Serum (FBS)"
  const parenMatches = Array.from(trimmed.matchAll(/\(([A-Z][A-Z0-9/-]{1,7})\)/g));
  const strippedParens = trimmed.replace(/\([^)]*\)/g, ' ').trim();
  const baseText = strippedParens.length > 0 ? strippedParens : trimmed;

  // Check known synonyms when single-token, exact alias, or prefix/substring match before grade qualifiers
  const upperBase = baseText.toUpperCase();
  for (const entry of KNOWN_REAGENT_SYNONYMS) {
    if (
      entry.aliases.some((a) => a.toUpperCase() === upperBase) ||
      entry.fullName.toUpperCase() === upperBase ||
      upperBase.startsWith(entry.fullName.toUpperCase() + ' ') ||
      upperBase.startsWith(entry.fullName.toUpperCase() + ',')
    ) {
      return entry.acronym;
    }
  }

  // Strip post-comma qualifier clauses (e.g. ", Premium Heat Inactivated, 1X") if base name before comma has >= 2 words
  const preComma = baseText.split(',')[0].trim();
  const textForTokens = preComma.split(/\s+/).length >= 2 ? preComma : baseText;

  // Tokenize words, ignoring concentrations, grades, and stop words
  const words = textForTokens
    .replace(/['’]/g, '')
    .split(/[\s\-_/(),:;]+/)
    .map((w) => w.trim())
    .filter(
      (w) =>
        w.length > 0 &&
        !STOP_WORDS.has(w.toLowerCase()) &&
        !UNIT_OR_CONCENTRATION_TOKEN.test(w) &&
        !/^(ph|sterile|filtered|grade|cell|culture|tested|liquid|1x|10x|premium|heat|inactivated|qualified|defined|dialyzed|irradiated|gamma|origin|united|states|usp)$/i.test(
          w
        )
    );

  // Fallback if all tokens were filtered (e.g. "Cell Culture Water")
  const effectiveWords =
    words.length > 0
      ? words
      : textForTokens
          .replace(/['’]/g, '')
          .split(/[\s\-_/(),:;]+/)
          .map((w) => w.trim())
          .filter((w) => w.length > 0 && !STOP_WORDS.has(w.toLowerCase()) && !UNIT_OR_CONCENTRATION_TOKEN.test(w));

  if (effectiveWords.length === 0) {
    if (parenMatches.length > 0) {
      return parenMatches[0][1].replace(/[^A-Z0-9]/gi, '').toUpperCase();
    }
    return trimmed.slice(0, 4).toUpperCase();
  }

  if (effectiveWords.length === 1) {
    const single = effectiveWords[0];
    if (/^[A-Z0-9]{2,8}$/i.test(single) && (single === single.toUpperCase() || single.length <= 5)) {
      return single.toUpperCase();
    }
    if (parenMatches.length > 0) {
      return parenMatches[0][1].replace(/[^A-Z0-9]/gi, '').toUpperCase();
    }
    return single.slice(0, 4).toUpperCase();
  }

  const firstLetterAcronym = effectiveWords.map((w) => w[0].toUpperCase()).join('');
  if (parenMatches.length > 0) {
    const parenAcronym = parenMatches[0][1].replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (firstLetterAcronym.startsWith(parenAcronym)) {
      return parenAcronym;
    }
  }
  return firstLetterAcronym;
}

/**
 * Checks whether a reagent string looks like an acronym (e.g. "FBS", "DMEM", "PBS", "P/S")
 * rather than a multi-word descriptive reagent name.
 */
export function isLikelyReagentAcronym(value?: string | null): boolean {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.toUpperCase() === 'N/A') return false;
  if (/\s/.test(trimmed)) return false;
  const cleaned = trimmed.replace(/[/-]/g, '');
  if (cleaned.length < 2 || cleaned.length > 8) return false;
  // Either already uppercase/alphanumeric or a known acronym alias
  if (cleaned === cleaned.toUpperCase() && /^[A-Z0-9]+$/.test(cleaned)) {
    return true;
  }
  return KNOWN_REAGENT_SYNONYMS.some(
    (entry) =>
      entry.acronym.toUpperCase() === cleaned.toUpperCase() ||
      entry.aliases.some((a) => normalizeAlphaNum(a) === cleaned.toUpperCase())
  );
}

/**
 * Determines whether two reagent representations (strings or ArchiveReagent objects)
 * refer to the SAME underlying reagent, regardless of whether one is referred to by
 * its full name (e.g., "Fetal Bovine Serum") and the other by its acronym (e.g., "FBS").
 */
export function areSameReagent(
  a?: Partial<ArchiveReagent> | string | null,
  b?: Partial<ArchiveReagent> | string | null
): boolean {
  if (!a || !b) return false;

  const extractTokens = (item: Partial<ArchiveReagent> | string) => {
    const rawName = typeof item === 'string' ? item.trim() : String(item.reagentName || '').trim();
    const rawAcronym =
      typeof item === 'string' ? '' : String(item.reagentAcronym || '').trim();

    const cleanName = rawName.toUpperCase() === 'N/A' ? '' : rawName;
    const cleanAcronym = rawAcronym.toUpperCase() === 'N/A' ? '' : rawAcronym;

    // Strip parenthetical acronym from name, e.g., "Fetal Bovine Serum (FBS)" -> "Fetal Bovine Serum"
    const baseName = cleanName.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    const derivedAcronym = cleanName ? generateReagentAcronym(cleanName) : '';
    const normDerivedAcronym =
      derivedAcronym && derivedAcronym !== 'N/A' ? normalizeAlphaNum(derivedAcronym) : '';
    const normExplicitAcronym = cleanAcronym ? normalizeAlphaNum(cleanAcronym) : '';
    const normName = baseName ? baseName.toLowerCase() : '';
    const normNameAlphaNum = baseName ? normalizeAlphaNum(baseName) : '';

    // All first-letter prefixes of multi-word names (minimum 2 words) to match qualified names
    // e.g. "Fetal Bovine Serum, Heat Inactivated" -> words ["Fetal", "Bovine", "Serum", "Heat", "Inactivated"] -> prefix "FBS"
    const words = baseName
      .replace(/['’]/g, '')
      .split(/[\s\-_/(),:;]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w.toLowerCase()) && !UNIT_OR_CONCENTRATION_TOKEN.test(w));

    const wordInitialPrefixes = new Set<string>();
    if (words.length >= 2) {
      let acc = '';
      for (const w of words) {
        acc += w[0].toUpperCase();
        if (acc.length >= 2) {
          wordInitialPrefixes.add(acc);
        }
      }
    }

    const acronyms = new Set<string>();
    if (normExplicitAcronym) acronyms.add(normExplicitAcronym);
    if (normDerivedAcronym) acronyms.add(normDerivedAcronym);
    if (isLikelyReagentAcronym(cleanName) && normNameAlphaNum) {
      acronyms.add(normNameAlphaNum);
    }

    // Check known reagent synonym table
    for (const syn of KNOWN_REAGENT_SYNONYMS) {
      const synAcronymNorm = normalizeAlphaNum(syn.acronym);
      const synFullNorm = syn.fullName.toLowerCase();
      const matchesSyn =
        acronyms.has(synAcronymNorm) ||
        normName === synFullNorm ||
        syn.aliases.some((al) => normalizeAlphaNum(al) === normNameAlphaNum || normalizeAlphaNum(al) === normExplicitAcronym);
      if (matchesSyn) {
        acronyms.add(synAcronymNorm);
        wordInitialPrefixes.add(synAcronymNorm);
      }
    }

    return {
      cleanName,
      baseName,
      normName,
      normNameAlphaNum,
      acronyms,
      wordInitialPrefixes,
      isMultiWord: words.length >= 2,
    };
  };

  const tokenA = extractTokens(a);
  const tokenB = extractTokens(b);

  if (!tokenA.cleanName && tokenA.acronyms.size === 0) return false;
  if (!tokenB.cleanName && tokenB.acronyms.size === 0) return false;

  // 1. Exact case-insensitive base name match
  if (tokenA.normName && tokenB.normName && tokenA.normName === tokenB.normName) {
    return true;
  }
  if (
    tokenA.normNameAlphaNum &&
    tokenB.normNameAlphaNum &&
    tokenA.normNameAlphaNum === tokenB.normNameAlphaNum
  ) {
    return true;
  }

  // 2. Shared acronym when neither has conflicting multi-word names
  const bothHaveDistinctMultiWordNames =
    tokenA.isMultiWord &&
    tokenB.isMultiWord &&
    tokenA.normName !== tokenB.normName &&
    !tokenA.normName.startsWith(tokenB.normName) &&
    !tokenB.normName.startsWith(tokenA.normName);

  if (!bothHaveDistinctMultiWordNames) {
    for (const acrA of tokenA.acronyms) {
      if (acrA.length >= 2 && (tokenB.acronyms.has(acrA) || tokenB.wordInitialPrefixes.has(acrA))) {
        return true;
      }
    }
    for (const acrB of tokenB.acronyms) {
      if (acrB.length >= 2 && (tokenA.acronyms.has(acrB) || tokenA.wordInitialPrefixes.has(acrB))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Merges two ArchiveReagent records representing the same reagent.
 * Prefers a full descriptive multi-word reagent name over an acronym for `reagentName`,
 * preserves `reagentAcronym`, and fills in any `'N/A'` fields (`manufacturer`, `catalogNumber`, `lotNumber`).
 */
export function mergeReagentRecords(
  existing: ArchiveReagent,
  incoming: Partial<ArchiveReagent>
): ArchiveReagent {
  const isValidField = (val?: string | null): val is string =>
    Boolean(val && val.trim() && val.trim().toUpperCase() !== 'N/A');

  const existingName = isValidField(existing.reagentName) ? existing.reagentName.trim() : '';
  const incomingName = isValidField(incoming.reagentName) ? incoming.reagentName.trim() : '';

  let chosenName = existingName || incomingName || 'N/A';
  if (existingName && incomingName) {
    const existingIsAcronym = isLikelyReagentAcronym(existingName);
    const incomingIsAcronym = isLikelyReagentAcronym(incomingName);
    if (existingIsAcronym && !incomingIsAcronym) {
      chosenName = incomingName;
    } else if (!existingIsAcronym && incomingIsAcronym) {
      chosenName = existingName;
    } else if (incomingName.length > existingName.length && existingIsAcronym === incomingIsAcronym) {
      chosenName = incomingName;
    }
  }

  const existingAcronym = isValidField(existing.reagentAcronym) ? existing.reagentAcronym.trim() : '';
  const incomingAcronym = isValidField(incoming.reagentAcronym) ? incoming.reagentAcronym.trim() : '';

  let chosenAcronym = existingAcronym || incomingAcronym || '';
  if (!chosenAcronym) {
    if (existingName && isLikelyReagentAcronym(existingName)) {
      chosenAcronym = existingName.toUpperCase();
    } else if (incomingName && isLikelyReagentAcronym(incomingName)) {
      chosenAcronym = incomingName.toUpperCase();
    } else if (chosenName !== 'N/A') {
      chosenAcronym = generateReagentAcronym(chosenName);
    } else {
      chosenAcronym = 'N/A';
    }
  }

  const chosenManufacturer = isValidField(existing.manufacturer)
    ? existing.manufacturer.trim()
    : isValidField(incoming.manufacturer)
      ? incoming.manufacturer.trim()
      : 'N/A';

  const chosenCatalog = isValidField(existing.catalogNumber)
    ? existing.catalogNumber.trim()
    : isValidField(incoming.catalogNumber)
      ? incoming.catalogNumber.trim()
      : 'N/A';

  const chosenLot = isValidField(existing.lotNumber)
    ? existing.lotNumber.trim()
    : isValidField(incoming.lotNumber)
      ? incoming.lotNumber.trim()
      : 'N/A';

  const mergedActionIds = Array.from(
    new Set([...(existing.actionIds || []), ...(incoming.actionIds || [])].filter(Boolean))
  );

  return {
    ...existing,
    reagentName: chosenName || 'N/A',
    reagentAcronym: chosenAcronym || 'N/A',
    manufacturer: chosenManufacturer,
    catalogNumber: chosenCatalog,
    lotNumber: chosenLot,
    rawLabelText: existing.rawLabelText || incoming.rawLabelText,
    eventId: existing.eventId || incoming.eventId,
    actionIds: mergedActionIds.length > 0 ? mergedActionIds : existing.actionIds,
  };
}

export const mergeArchiveReagents = mergeReagentRecords;

/**
 * Parses reagent bottle/container label OCR text and/or explicit model fields into
 * a normalized `ArchiveReagent` object:
 * - reagentName
 * - reagentAcronym (formed from the first letters of the reagent name when not explicitly printed)
 * - manufacturer
 * - catalogNumber (Catalog / Ref #)
 * - lotNumber (Lot #)
 * Any field not present on the label defaults to `'N/A'`.
 */
export function parseReagentLabelFields(
  rawText?: string | null,
  explicitFields?: (Partial<ArchiveReagent> & Record<string, any>) | null
): ArchiveReagent {
  const cleanField = (val: unknown): string => {
    const s = String(val ?? '').trim();
    if (!s || /^(n\/?a|none|null|undefined|unknown|-)$/i.test(s)) {
      return '';
    }
    return s;
  };

  const nested =
    explicitFields && typeof explicitFields.reagentData === 'object' && explicitFields.reagentData
      ? explicitFields.reagentData
      : {};

  let reagentName =
    cleanField(explicitFields?.reagentName) || cleanField(nested?.reagentName);
  let reagentAcronym =
    cleanField(explicitFields?.reagentAcronym) || cleanField(nested?.reagentAcronym);
  let manufacturer =
    cleanField(explicitFields?.manufacturer) || cleanField(nested?.manufacturer);
  let catalogNumber =
    cleanField(explicitFields?.catalogNumber) ||
    cleanField(explicitFields?.refNumber) ||
    cleanField(explicitFields?.catalogRef) ||
    cleanField(nested?.catalogNumber);
  let lotNumber =
    cleanField(explicitFields?.lotNumber) || cleanField(nested?.lotNumber);

  // If reagentName was mistakenly populated with a pure manufacturer name (e.g. "gibco"), move it to manufacturer
  if (reagentName) {
    const matchedMfr = KNOWN_MANUFACTURERS.find(
      (m) => m.toLowerCase() === reagentName.toLowerCase()
    );
    if (matchedMfr) {
      if (!manufacturer) {
        manufacturer = matchedMfr;
      }
      reagentName = '';
    } else {
      for (const knownMfr of KNOWN_MANUFACTURERS) {
        const escaped = knownMfr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const prefixRe = new RegExp(`^${escaped}\\s+`, 'i');
        if (prefixRe.test(reagentName)) {
          if (!manufacturer) {
            manufacturer = knownMfr;
          }
          reagentName = reagentName.replace(prefixRe, '').trim();
          break;
        }
      }
    }
  }

  // Normalize canonical manufacturer casing if matching a known manufacturer
  if (manufacturer) {
    const canonicalMfr = KNOWN_MANUFACTURERS.find(
      (m) => m.toLowerCase() === manufacturer.toLowerCase()
    );
    if (canonicalMfr) {
      manufacturer = canonicalMfr;
    }
  }

  const cleanReagentNameCandidate = (rawLine: string, currentMfr?: string): string => {
    let cleaned = rawLine
      .replace(
        /\b(?:Cat(?:alog)?|REF|Reference|Part|Item|Prod(?:uct)?|Lot|LOT|Batch|Mfr|Manufacturer|Manufactured\s+by|Exp(?:iry|iration)?|EXP|Store\s+at|Storage|Origin)\b.*$/i,
        ''
      )
      .replace(/\b\d{4}[-/]\d{2}(?:[-/]\d{2})?\b/g, '')
      .replace(/\b\d+(?:\.\d+)?\s*(?:mL|L|uL|µL|mg|g|kg)\b/gi, '')
      .replace(/\b\d+(?:\.\d+)?X\b/gi, '')
      .trim();

    if (currentMfr) {
      const esc = currentMfr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(new RegExp(`^${esc}\\b[\\s,:;-]*`, 'i'), '').trim();
    }
    for (const knownMfr of KNOWN_MANUFACTURERS) {
      const esc = knownMfr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(new RegExp(`^${esc}\\b[\\s,:;-]*`, 'i'), '').trim();
    }

    // Strip trailing grade/treatment qualifiers such as ", Premium Heat Inactivated" or "Premium Heat Inactivated"
    cleaned = cleaned
      .replace(
        /[,\s]+\b(?:Premium\s+Heat\s+Inactivated|Heat\s+Inactivated|Premium|Qualified|Cell\s+Culture\s+Tested|Sterile\s+Filtered)\b.*$/i,
        ''
      )
      .trim()
      .replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, '');

    return cleaned;
  };

  if (reagentName) {
    const cleanedExplicitName = cleanReagentNameCandidate(reagentName, manufacturer);
    if (cleanedExplicitName) {
      reagentName = cleanedExplicitName;
    }
  }

  const fullText = String(
    rawText ??
      explicitFields?.rawLabelText ??
      explicitFields?.fullText ??
      nested?.rawLabelText ??
      ''
  ).trim();

  if (fullText) {
    // 1. Extract Catalog / Ref # if missing
    if (!catalogNumber) {
      const catMatch = fullText.match(
        /\b(?:Cat(?:alog)?|REF|Reference|Part|Item|Prod(?:uct)?)\s*(?:No\.?|Num(?:ber)?|#|:)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-./]{2,24})/i
      );
      if (catMatch?.[1]) {
        catalogNumber = catMatch[1].trim();
      }
    }

    // 2. Extract Lot # if missing
    if (!lotNumber) {
      const lotMatch = fullText.match(
        /\b(?:Lot|LOT|Batch)\s*(?:No\.?|Num(?:ber)?|#|:)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-./]{2,24})/i
      );
      if (lotMatch?.[1]) {
        lotNumber = lotMatch[1].trim();
      }
    }

    // 3. Extract Manufacturer if missing
    if (!manufacturer) {
      const mfrExplicit = fullText.match(
        /\b(?:Manufacturer|Mfr\.?|Manufactured\s+by|Mfd\.?\s+by|Brand)\s*[:#-]?\s*([^\n|;,]+)/i
      );
      if (mfrExplicit?.[1]) {
        manufacturer = mfrExplicit[1].trim();
      } else {
        for (const knownMfr of KNOWN_MANUFACTURERS) {
          const escaped = knownMfr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp(`\\b${escaped}\\b`, 'i').test(fullText)) {
            manufacturer = knownMfr;
            break;
          }
        }
      }
    }

    // 4. Extract Reagent Name & Acronym from lines if missing
    if (!reagentName || !reagentAcronym) {
      const lines = fullText
        .split(/[\r\n|]+/)
        .map((l) => l.trim())
        .filter(Boolean);

      const candidateLines: string[] = [];
      for (const line of lines) {
        // Skip lines that begin directly with metadata markers
        if (
          /^(?:Cat(?:alog)?|REF|Reference|Part|Item|Prod(?:uct)?|Lot|LOT|Batch|Mfr|Manufacturer|Manufactured\s+by|Exp(?:iry|iration)?|EXP|Store\s+at|Storage|Origin)\b/i.test(
            line
          )
        ) {
          continue;
        }
        const stripped = cleanReagentNameCandidate(line, manufacturer);

        if (!stripped) continue;
        // Skip if line is purely manufacturer name
        if (
          manufacturer &&
          stripped.toLowerCase() === manufacturer.toLowerCase()
        ) {
          continue;
        }
        if (
          KNOWN_MANUFACTURERS.some(
            (m) => m.toLowerCase() === stripped.toLowerCase()
          )
        ) {
          continue;
        }
        // Skip if line is purely a number, date, or concentration
        if (UNIT_OR_CONCENTRATION_TOKEN.test(stripped)) continue;
        if (/^\d{4}[-/]\d{2}([-/]\d{2})?$/.test(stripped)) continue;

        candidateLines.push(stripped);
      }

      for (const candidate of candidateLines) {
        // Check if candidate has "Full Name (ACRONYM)" pattern
        const parenMatch = candidate.match(/^(.+?)\s*\(([A-Z][A-Z0-9/-]{1,7})\)$/);
        if (parenMatch) {
          const namePart = parenMatch[1].trim();
          const acrPart = parenMatch[2].trim();
          if (!reagentName && namePart.length > 1) {
            reagentName = namePart;
          }
          if (!reagentAcronym && isLikelyReagentAcronym(acrPart)) {
            reagentAcronym = acrPart.toUpperCase();
          }
          continue;
        }

        if (isLikelyReagentAcronym(candidate)) {
          if (!reagentAcronym) {
            reagentAcronym = candidate.toUpperCase();
          }
        } else if (!reagentName && candidate.length >= 2) {
          reagentName = candidate;
        }
      }
    }
  }

  // If reagentNameitself contains "Full Name (ACRONYM)", split out acronym
  if (reagentName) {
    const parenMatch = reagentName.match(/^(.+?)\s*\(([A-Z][A-Z0-9/-]{1,7})\)$/);
    if (parenMatch && isLikelyReagentAcronym(parenMatch[2])) {
      reagentName = parenMatch[1].trim();
      if (!reagentAcronym) {
        reagentAcronym = parenMatch[2].trim().toUpperCase();
      }
    }
  }

  // Reconcile reagentName and reagentAcronym:
  // Either acronym or full name might be printed on the vessel containing the reagent.
  // If the full name is printed on the label and acronym is not, form the acronym from the first letters of the reagent name.
  // If only the acronym is printed on the label and the full name is not, leave reagentName as 'N/A' and set reagentAcronym.
  if (reagentName && !reagentAcronym) {
    reagentAcronym = generateReagentAcronym(reagentName);
  }

  return {
    id: explicitFields?.id || nested?.id,
    reagentName: reagentName || 'N/A',
    reagentAcronym: reagentAcronym || 'N/A',
    manufacturer: manufacturer || 'N/A',
    catalogNumber: catalogNumber || 'N/A',
    lotNumber: lotNumber || 'N/A',
    rawLabelText: fullText || undefined,
    eventId: explicitFields?.eventId || nested?.eventId,
    actionIds: explicitFields?.actionIds || nested?.actionIds,
  };
}

/**
 * Heuristic check to detect when transcribed OCR text belongs to a commercial reagent bottle/vessel
 * rather than a small cell line cryovial (e.g. contains REF/Catalog #, commercial bottle volume >= 50 mL,
 * known reagent manufacturer, or known reagent name/synonym).
 */
export function isLikelyReagentBottleLabelText(rawText?: string | null): boolean {
  const text = String(rawText || '').trim();
  if (!text) return false;

  // Check for commercial Catalog / REF number pattern alongside LOT or manufacturer or bottle volume
  const hasCatalogOrRef = /\b(?:Cat(?:alog)?\s*(?:No\.?|#|:)?|REF)\s*[:#-]?\s*[A-Z0-9][A-Z0-9\-./]{2,24}\b/i.test(
    text
  );
  const hasBottleVolume = /\b(?:[5-9]\d|[1-9]\d{2,3})\s*(?:mL|L)\b/i.test(text);
  const hasOriginOrInactivated = /\b(?:Origin:\s*United\s*States|Heat\s+Inactivated|Sterile\s+Filtered)\b/i.test(
    text
  );
  const hasKnownManufacturer = KNOWN_MANUFACTURERS.some((mfr) => {
    const escaped = mfr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  });
  const hasKnownReagentFullName = KNOWN_REAGENT_SYNONYMS.some((entry) => {
    const escaped = entry.fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  });

  return (
    hasCatalogOrRef ||
    hasKnownReagentFullName ||
    hasOriginOrInactivated ||
    (hasKnownManufacturer && (hasBottleVolume || /\bLOT\b/i.test(text)))
  );
}

/**
 * Computes the expected number of seeding events given a plate type (e.g., "96-well plate")
 * and a pipette type (e.g., "8-channel pipette").
 * Example: 96-well plate with 8-channel pipette -> 96 / 8 = 12 seeding events.
 * Example: 96-well plate with 12-channel pipette -> 96 / 12 = 8 seeding events.
 * Example: 96-well plate with single-channel pipette -> 96 / 1 = 96 seeding events.
 */
export function computeExpectedSeedingEvents(
  plateType?: string | null,
  pipetteType?: string | null
): number | undefined {
  const plateStr = String(plateType || '').toLowerCase();
  const pipetteStr = String(pipetteType || '').toLowerCase();

  let totalWells: number | undefined;
  const wellMatch = plateStr.match(/(\d+)\s*[-\s]?well/);
  if (wellMatch) {
    totalWells = parseInt(wellMatch[1], 10);
  } else if (/\b(6|12|24|48|96|384)\b/.test(plateStr)) {
    const m = plateStr.match(/\b(6|12|24|48|96|384)\b/);
    if (m) totalWells = parseInt(m[1], 10);
  }

  let channels: number | undefined;
  const channelMatch = pipetteStr.match(/(\d+)\s*[-\s]?channel/);
  if (channelMatch) {
    channels = parseInt(channelMatch[1], 10);
  } else if (pipetteStr.includes('single') || pipetteStr.includes('1-channel')) {
    channels = 1;
  } else if (/\b(1|8|12|16)\b/.test(pipetteStr)) {
    const m = pipetteStr.match(/\b(1|8|12|16)\b/);
    if (m) channels = parseInt(m[1], 10);
  }

  if (totalWells && channels && channels > 0) {
    return Math.round(totalWells / channels);
  }
  return undefined;
}

/**
 * Structured Reagent entry for the Experiment Archive Notebook table:
 * Columns: Reagent Name | Reagent Acronym | Manufacturer | Catalog / Ref # | Lot #
 * Missing fields default to 'N/A'.
 */
export const ArchiveReagentSchema = z.object({
  id: z.string().optional(),
  reagentName: z.string().min(1).default('N/A'),
  reagentAcronym: z.string().default('N/A'),
  manufacturer: z.string().default('N/A'),
  catalogNumber: z.string().default('N/A'),
  lotNumber: z.string().default('N/A'),
  rawLabelText: z.string().optional(),
  eventId: z.string().optional(),
  actionIds: z.array(z.string()).optional(),
});
export type ArchiveReagent = z.infer<typeof ArchiveReagentSchema>;

/**
 * Structured data extracted for Action: Mix Reagents (`REAGENT_MIXING_ACTION` / `MIX_REAGENTS`).
 * Mixes two reagents with their names/acronyms and mixing amounts.
 */
export const MixReagentsActionDataSchema = z.object({
  firstReagentName: z.string().default('N/A'),
  firstReagentAcronym: z.string().optional(),
  firstReagentAmount: z.string().default('N/A'),
  secondReagentName: z.string().default('N/A'),
  secondReagentAcronym: z.string().optional(),
  secondReagentAmount: z.string().default('N/A'),
  notes: z.string().optional(),
});
export type MixReagentsActionData = z.infer<typeof MixReagentsActionDataSchema>;

/**
 * Structured data extracted for Action: Seed Reagents (`REAGENT_SEEDING_ACTION` / `SEED_REAGENTS`).
 * Seeds reagent/cells into a plate and verifies the number of seeding events.
 * For a 96-well plate, rows are designated A-H and columns are 1-12 (column 1 on the left to column 12 on the right),
 * without any cryo-box top-left black corner origin marker.
 */
export const SeedReagentsActionDataSchema = z.object({
  plateType: z.string().default('N/A'),
  pipetteType: z.string().default('N/A'),
  cellsSeeded: z.string().default('N/A'),
  cellsPerWell: z.string().default('N/A'),
  seedingEventsCount: z.number().int().nonnegative().default(0),
  expectedSeedingEventsCount: z.number().int().positive().optional(),
  isSeedingCountCorrect: z.boolean().optional(),
  seedingEventTimestamps: z.array(z.number().nonnegative()).optional(),
  seededColumns: z.array(z.number().int().min(1).max(12)).optional(),
  seededWells: z.array(z.string()).optional(),
  notes: z.string().optional(),
});
export type SeedReagentsActionData = z.infer<typeof SeedReagentsActionDataSchema>;

const NON_CELL_MEDIA_REAGENT_NAMES = new Set([
  'N/A',
  'NA',
  'UNKNOWN',
  'NONE',
  'DMEM',
  "DULBECCO'S MODIFIED EAGLE MEDIUM",
  'DULBECCO MODIFIED EAGLE MEDIUM',
  'FBS',
  'FETAL BOVINE SERUM',
  'PBS',
  'PHOSPHATE BUFFERED SALINE',
  'PHOSPHATE-BUFFERED SALINE',
  'DPBS',
  'HBSS',
  'RPMI',
  'RPMI-1640',
  'RPMI 1640',
  'MEM',
  'OPTI-MEM',
  'OPTIMEM',
  'PS',
  'P/S',
  'PEN-STREP',
  'PENICILLIN-STREPTOMYCIN',
  'PENICILLIN STREPTOMYCIN',
  'TRYPSIN',
  'TRYPSIN-EDTA',
  'TE',
  'EDTA',
  'DMSO',
  'CGM',
  'COMPLETE GROWTH MEDIUM',
  'COMPLETE MEDIA',
  'GROWTH MEDIA',
  'GROWTH MEDIUM',
  'BASAL MEDIA',
  'BASAL MEDIUM',
  'MEDIA',
  'MEDIUM',
  'BUFFER',
  'SERUM',
  'WATER',
  'REAGENT',
]);

function isNonCellMediaOrBuffer(nameOrAcronym?: string | null): boolean {
  const clean = String(nameOrAcronym || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  if (!clean) return true;
  if (NON_CELL_MEDIA_REAGENT_NAMES.has(clean)) return true;
  const withoutAcronymSuffix = clean.replace(/\s*\([A-Z0-9/-]+\)\s*$/, '').trim();
  if (NON_CELL_MEDIA_REAGENT_NAMES.has(withoutAcronymSuffix)) return true;
  return false;
}

const NUMBER_WORD_MAP: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  twentyfive: 25,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

/**
 * Extracts `cellsPerWell` from spoken audio transcripts, `PROTOCOL_AUDIO_UTTERANCE_EVENT` descriptions,
 * or refinement text.
 * Supports:
 * 1. Direct mentions (e.g., "3K cells/well", "3,000 cells per well", "3000 cells/well", "three thousand cells per well").
 * 2. Calculation from spoken cell concentration in cells/mL + volume per well in µL/microliters or mL
 *    (e.g., "30K cells/mL, each well receives 100 microliters of reagent" -> "3K cells/well").
 */
export function extractCellsPerWellFromText(text?: string | null): string | undefined {
  const str = String(text || '');
  if (!str.trim()) return undefined;

  // 1. Direct numeric mention: e.g. "3K cells/well", "3,000 cells per well", "3000 cells/well", "5 x 10^4 cells/well"
  const directMatch = str.match(
    /\b(\d+(?:,\d{3})*(?:\.\d+)?(?:\s*[xX×]\s*10\^?\d+)?)\s*([kKmM]|thousand|million)?\s*cells?\s*(?:\/|\s+per\s+|\s+in(?:to)?\s+each\s+|\s+to\s+each\s+|\s+a\s+)\s*well\b/i
  );
  if (directMatch) {
    const rawNum = directMatch[1].trim();
    const unitSuffix = (directMatch[2] || '').trim().toLowerCase();
    if (unitSuffix === 'k') {
      return `${rawNum}K cells/well`;
    }
    if (unitSuffix === 'm' || unitSuffix === 'million') {
      return `${rawNum}M cells/well`;
    }
    if (unitSuffix === 'thousand') {
      const n = parseFloat(rawNum.replace(/,/g, ''));
      if (!isNaN(n)) {
        return `${Math.round(n * 1000).toLocaleString('en-US')} cells/well`;
      }
      return `${rawNum}K cells/well`;
    }
    return `${rawNum} cells/well`;
  }

  // 2. Spelled-out number words: e.g. "three thousand cells per well"
  const wordMatch = str.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\s+(thousand|million)\s+cells?\s*(?:\/|\s+per\s+|\s+in(?:to)?\s+each\s+)\s*well\b/i
  );
  if (wordMatch) {
    const base = NUMBER_WORD_MAP[wordMatch[1].toLowerCase()];
    const mult = wordMatch[2].toLowerCase() === 'million' ? 1_000_000 : 1_000;
    if (base) {
      return `${(base * mult).toLocaleString('en-US')} cells/well`;
    }
  }

  // 3. Calculate from concentration (cells/mL) and volume per well (µL / microliters / mL)
  // e.g. "there are 30K cells/mL, each well receives 100 microliters of reagent"
  const concMatch = str.match(
    /\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*([kKmM]|thousand|million)?\s*cells?\s*(?:\/|\s+per\s+)\s*(?:m[lL]|millilit(?:er|re)s?)\b/i
  );
  if (concMatch) {
    const baseConc = parseFloat(concMatch[1].replace(/,/g, ''));
    const concUnit = (concMatch[2] || '').trim().toLowerCase();
    const usedK = concUnit === 'k';
    let concPerMl = baseConc;
    if (concUnit === 'k' || concUnit === 'thousand') concPerMl *= 1_000;
    else if (concUnit === 'm' || concUnit === 'million') concPerMl *= 1_000_000;

    // Look for volume in microliters / µL / uL (or mL)
    const volUlMatch = str.match(
      /\b(\d+(?:\.\d+)?)\s*(?:µ[lL]|u[lL]|μ[lL]|microlit(?:er|re)s?)\b/i
    );
    if (!isNaN(concPerMl) && concPerMl > 0 && volUlMatch) {
      const volUl = parseFloat(volUlMatch[1]);
      if (!isNaN(volUl) && volUl > 0) {
        const computedCellsPerWell = Math.round(concPerMl * (volUl / 1000));
        if (computedCellsPerWell > 0) {
          if (usedK && computedCellsPerWell >= 1000 && computedCellsPerWell % 1000 === 0) {
            return `${computedCellsPerWell / 1000}K cells/well`;
          }
          return `${computedCellsPerWell.toLocaleString('en-US')} cells/well`;
        }
      }
    }
  }

  return undefined;
}

/**
 * Extracts `cellsSeeded` (cell line / reagent being seeded) from spoken audio, event descriptions,
 * action descriptions, and/or detected reagents.
 */
export function extractCellsSeededFromText(
  text?: string | null,
  knownReagents?: Array<{ reagentName?: string; reagentAcronym?: string }>
): string | undefined {
  const str = String(text || '');

  // Candidate non-media reagents (e.g. "A549") from the reagents table / label presentations
  const cellReagentCandidates: string[] = [];
  if (Array.isArray(knownReagents)) {
    for (const r of knownReagents) {
      const rName = String(r?.reagentName || '').trim();
      const rAcr = String(r?.reagentAcronym || '').trim();
      const candidate =
        rName && rName !== 'N/A'
          ? rName
          : rAcr && rAcr !== 'N/A'
          ? rAcr
          : '';
      if (candidate && !isNonCellMediaOrBuffer(candidate) && !isNonCellMediaOrBuffer(rAcr)) {
        cellReagentCandidates.push(candidate);
      }
    }
  }

  // 1. If any candidate reagent from the Reagents Table is mentioned in the text, return it immediately
  if (str.trim() && cellReagentCandidates.length > 0) {
    const upperStr = str.toUpperCase();
    for (const cand of cellReagentCandidates) {
      if (upperStr.includes(cand.toUpperCase())) {
        return cand;
      }
    }
  }

  if (str.trim()) {
    // 2. Explicit seeding phrase: e.g. "Operator seeds A549 cells into a 96-well plate", "seeds Jurkat T-cells into..."
    const seedVerbMatch = str.match(
      /\b(?:seeds?|seeding|dispens(?:es?|ing)|plat(?:es?|ing))\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9._-]*(?:\s+T-cells)?)\s+(?:cells?|suspension)\b/i
    );
    if (seedVerbMatch) {
      const candidate = seedVerbMatch[1].trim();
      const stopWords = new Set([
        'the',
        'some',
        'all',
        'into',
        'across',
        'in',
        'onto',
        'reconstituted',
        'diluted',
        'cultured',
        'human',
        'mammalian',
        'adherent',
        'suspension',
      ]);
      if (!stopWords.has(candidate.toLowerCase()) && !isNonCellMediaOrBuffer(candidate)) {
        return candidate;
      }
    }

    // 3. "cells/well of <CELL_LINE> suspension/cells" e.g. "3000 cells/well of HEK293T suspension"
    const ofSuspensionMatch = str.match(
      /\b(?:cells?\s*(?:\/|per)\s*(?:well|m[lL])|µ[lL]|u[lL]|microlit(?:er|re)s?)\s+of\s+([A-Za-z0-9][A-Za-z0-9._-]*(?:\s+T-cells)?)\b/i
    );
    if (ofSuspensionMatch) {
      const candidate = ofSuspensionMatch[1].trim();
      if (
        !/^(reagent|media|medium|buffer|solution|suspension|cells?)$/i.test(candidate) &&
        !isNonCellMediaOrBuffer(candidate)
      ) {
        return candidate;
      }
    }

    // 4. "<CELL_LINE> cells" or "<CELL_LINE> cell suspension/proliferation/line"
    const beforeCellsMatch = str.match(
      /\b([A-Z][A-Za-z0-9-]{1,15}(?:\s+T-cells)?)\s+(?:cells?\b|cell\s+(?:suspension|proliferation|line|culture|seeding))/
    );
    if (beforeCellsMatch) {
      const candidate = beforeCellsMatch[1].trim();
      const stopWords = new Set([
        'The',
        'Seed',
        'Seeds',
        'Seeded',
        'Seeding',
        'Dispense',
        'Dispensing',
        'Growing',
        'Cultured',
        'Viable',
        'Mammalian',
        'Human',
        'Total',
        'Thousand',
      ]);
      if (!stopWords.has(candidate) && !isNonCellMediaOrBuffer(candidate)) {
        return candidate;
      }
    }

    // 5. Known standard cell line identifiers anywhere in the text
    const knownCellLineMatch = str.match(
      /\b(A549|HeLa|HEK\s*293T?|Jurkat(?:\s+T-cells)?|MCF-?7|CHO(?:-K1)?|U2OS|NIH-?3T3|K562|SH-?SY5Y|THP-?1|PC-?3|HCT-?116|MDA-MB-231|HepG2|Caco-?2|Vero|COS-?7|Raji|Daudi|RAW\s*264\.7|L929|B16(?:-F10)?|CT26|4T1|iPSC(?:-Clone-\d+)?)\b/i
    );
    if (knownCellLineMatch) {
      return knownCellLineMatch[1].replace(/\s+/g, ' ').trim();
    }
  }

  // 6. If the Reagents Table has a single non-media cell/reagent entry (e.g. "A549"), use it
  if (cellReagentCandidates.length === 1) {
    return cellReagentCandidates[0];
  }

  return undefined;
}

/**
 * Extracts `plateType` (e.g., "96-well plate") from text if mentioned.
 */
export function extractPlateTypeFromText(text?: string | null): string | undefined {
  const str = String(text || '');
  if (!str.trim()) return undefined;
  const match = str.match(
    /\b(6|12|24|48|96|384)\s*[-\s]?well(?:\s+(?:clear[-\s]?bottom|flat[-\s]?bottom|u[-\s]?bottom|v[-\s]?bottom|tissue[-\s]?culture|tc))*\s*(?:micro)?plate\b/i
  );
  if (match) {
    return `${match[1]}-well plate`;
  }
  const shortMatch = str.match(/\b(6|12|24|48|96|384)\s*[-\s]?well\b/i);
  if (shortMatch) {
    return `${shortMatch[1]}-well plate`;
  }
  return undefined;
}

/**
 * Extracts `pipetteType` (e.g., "8-channel pipette") from text if mentioned.
 */
export function extractPipetteTypeFromText(text?: string | null): string | undefined {
  const str = String(text || '');
  if (!str.trim()) return undefined;
  const channelMatch = str.match(
    /\b(\d+)\s*[-\s]?(?:channel|way)\s+(?:multi[-\s]?channel\s+|precision\s+|electronic\s+|micro)?pipett?(?:e|or)\b/i
  );
  if (channelMatch) {
    return `${channelMatch[1]}-channel pipette`;
  }
  const multiMatch = str.match(/\b(\d+)\s*[-\s]?(?:channel|way)\s+multichannel\b/i);
  if (multiMatch) {
    return `${multiMatch[1]}-channel pipette`;
  }
  const genericPipetteMatch = str.match(
    /\b(single[-\s]?channel|multi[-\s]?channel|multichannel|serological)\s+pipett?(?:e|or)\b/i
  );
  if (genericPipetteMatch) {
    const kind = genericPipetteMatch[1].toLowerCase();
    if (kind === 'multi-channel' || kind === 'multichannel') {
      return 'Multi-channel pipette';
    }
    if (kind.startsWith('single')) {
      return 'Single-channel pipette';
    }
    return `${genericPipetteMatch[1]} pipette`;
  }
  return undefined;
}

export interface ResolveSeedReagentsContext {
  explicitCandidates?: Array<Partial<SeedReagentsActionData> | undefined | null>;
  actionDescription?: string | null;
  cellLineName?: string | null;
  cellLineInfo?: Record<string, any> | null;
  audioAndEventTexts?: Array<string | undefined | null>;
  reagents?: Array<{ reagentName?: string; reagentAcronym?: string }> | null;
}

/**
 * Resolves `plateType`, `pipetteType`, `cellsSeeded`, and `cellsPerWell` for a `SEED_REAGENTS` action
 * strictly from the operator's spoken audio and detected events/reagents.
 *
 * Anti-Placeholder Guarantee:
 * - Never injects hardcoded fallback values ("HEK293T", "10,000 cells/well", etc.).
 * - Rejects stale legacy placeholders ("HEK293T", "10,000 cells/well") if they are not supported by
 *   the detected events, audio transcript, or action metadata.
 * - Any field whose relevant information cannot be found in the detected events/audio is set to "N/A".
 */
export function resolveSeedReagentsDataFromContext(ctx: ResolveSeedReagentsContext): {
  plateType: string;
  pipetteType: string;
  cellsSeeded: string;
  cellsPerWell: string;
} {
  const candidates = (ctx.explicitCandidates || []).filter(Boolean) as Partial<SeedReagentsActionData>[];
  const audioAndEventStr = (ctx.audioAndEventTexts || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join('\n');
  const actionDescStr = String(ctx.actionDescription || '').trim();
  const cellLineNameStr = String(ctx.cellLineName || '').trim();
  const cellDensityStr = String(
    ctx.cellLineInfo?.cellDensity || ctx.cellLineInfo?.cellsPerWell || ''
  ).trim();
  const volumePerWellStr = String(ctx.cellLineInfo?.volumePerWell || '').trim();
  const reagentNamesStr = (ctx.reagents || [])
    .map((r) => `${r?.reagentName || ''} ${r?.reagentAcronym || ''}`.trim())
    .filter(Boolean)
    .join(' ');

  const combinedEvidenceText = [
    audioAndEventStr,
    actionDescStr,
    cellLineNameStr,
    cellDensityStr,
    volumePerWellStr,
    reagentNamesStr,
  ]
    .filter(Boolean)
    .join('\n');

  const isNonEmptyValue = (v?: string | null): v is string => {
    const s = String(v || '').trim();
    return Boolean(s && s.toUpperCase() !== 'N/A' && s.toUpperCase() !== 'UNKNOWN');
  };

  // 1. Resolve cellsSeeded
  const extractedCellsFromAudioOrDesc = extractCellsSeededFromText(
    [audioAndEventStr, actionDescStr, cellLineNameStr].filter(Boolean).join('\n'),
    ctx.reagents || undefined
  );

  let validExplicitCells: string | undefined;
  for (const c of candidates) {
    if (isNonEmptyValue(c.cellsSeeded)) {
      const val = c.cellsSeeded.trim();
      const isLegacyHekPlaceholder = /^hek\s*29?3t?$/i.test(val);
      if (isLegacyHekPlaceholder) {
        const hekInEvidence = /\bhek\s*29?3t?\b/i.test(combinedEvidenceText);
        const conflictsWithExtracted =
          extractedCellsFromAudioOrDesc &&
          !/^hek\s*29?3t?$/i.test(extractedCellsFromAudioOrDesc);
        if (!hekInEvidence || conflictsWithExtracted) {
          continue;
        }
      }
      validExplicitCells = val;
      break;
    }
  }

  // Prefer audio/event/reagent extraction when explicit value was a conflicting cell line or absent
  const cellsSeeded =
    extractedCellsFromAudioOrDesc ||
    validExplicitCells ||
    (isNonEmptyValue(cellLineNameStr) ? cellLineNameStr : undefined) ||
    'N/A';

  // 2. Resolve cellsPerWell
  const extractedCellsPerWellFromAudio = extractCellsPerWellFromText(
    [audioAndEventStr, cellDensityStr, actionDescStr].filter(Boolean).join('\n')
  );

  let validExplicitCellsPerWell: string | undefined;
  for (const c of candidates) {
    if (isNonEmptyValue(c.cellsPerWell)) {
      const val = c.cellsPerWell.trim();
      const isLegacy10kPlaceholder = /^10,?000\s*cells?\s*(?:\/|per)\s*well$/i.test(val);
      if (isLegacy10kPlaceholder) {
        const tenKInEvidence = /\b(?:10,?000|10\s*k|10\s*thousand|1\s*[xX×]\s*10\^?4)\b/i.test(
          combinedEvidenceText
        );
        const conflictsWithExtracted =
          extractedCellsPerWellFromAudio &&
          !/^10,?000\b|^10k\b/i.test(extractedCellsPerWellFromAudio);
        if (!tenKInEvidence || conflictsWithExtracted) {
          continue;
        }
      }
      validExplicitCellsPerWell = val;
      break;
    }
  }

  const cellsPerWell =
    extractedCellsPerWellFromAudio ||
    validExplicitCellsPerWell ||
    (isNonEmptyValue(cellDensityStr) ? cellDensityStr : undefined) ||
    'N/A';

  // 3. Resolve plateType
  const extractedPlateType = extractPlateTypeFromText(
    [audioAndEventStr, actionDescStr].filter(Boolean).join('\n')
  );
  let validExplicitPlateType: string | undefined;
  for (const c of candidates) {
    if (isNonEmptyValue(c.plateType)) {
      const val = c.plateType.trim();
      if (
        /^96-well plate$/i.test(val) &&
        !extractedPlateType &&
        !combinedEvidenceText.trim() &&
        !validExplicitCells &&
        !validExplicitCellsPerWell
      ) {
        continue;
      }
      validExplicitPlateType = val;
      break;
    }
  }
  const plateType = extractedPlateType || validExplicitPlateType || 'N/A';

  // 4. Resolve pipetteType
  const extractedPipetteType = extractPipetteTypeFromText(
    [audioAndEventStr, actionDescStr].filter(Boolean).join('\n')
  );
  let validExplicitPipetteType: string | undefined;
  for (const c of candidates) {
    if (isNonEmptyValue(c.pipetteType)) {
      const val = c.pipetteType.trim();
      if (
        /^8-channel pipette$/i.test(val) &&
        !extractedPipetteType &&
        !combinedEvidenceText.trim() &&
        !validExplicitCells &&
        !validExplicitCellsPerWell
      ) {
        continue;
      }
      validExplicitPipetteType = val;
      break;
    }
  }
  const pipetteType = extractedPipetteType || validExplicitPipetteType || 'N/A';

  return {
    plateType,
    pipetteType,
    cellsSeeded,
    cellsPerWell,
  };
}

export const PLATE_96_ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
export const PLATE_96_COLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/**
 * Parses column numbers (1..12) from free text such as "columns 1 to 6", "columns 1-12",
 * "Col 3", or well ranges like "A1:H6".
 */
export function parseColumnNumbersFromText(text?: string | null): number[] {
  const str = String(text || '');
  if (!str.trim()) return [];
  const cols = new Set<number>();

  // Range e.g. "columns 1 to 6", "cols 1-12", "columns 1 through 12"
  const rangeRegex = /\bcol(?:umn)?s?\s*(\d{1,2})\s*(?:-|–|to|through)\s*(\d{1,2})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rangeRegex.exec(str)) !== null) {
    const start = Math.max(1, Math.min(12, parseInt(m[1], 10)));
    const end = Math.max(1, Math.min(12, parseInt(m[2], 10)));
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    for (let c = lo; c <= hi; c++) cols.add(c);
  }

  // Comma-separated or list of columns e.g. "columns 1, 3, 5, 12" or "cols 1, 2, 3"
  const listRegex = /\bcol(?:umn)?s?\s+([0-9\s,and&]+)\b/gi;
  while ((m = listRegex.exec(str)) !== null) {
    const parts = m[1].split(/[\s,]+|\band\b|&/i);
    for (const p of parts) {
      const c = parseInt(p.trim(), 10);
      if (Number.isInteger(c) && c >= 1 && c <= 12) {
        cols.add(c);
      }
    }
  }

  // Well range e.g. "A1:H6" or "A1-H12"
  const wellRangeRegex = /\b([A-H])(\d{1,2})\s*[:\-–]\s*([A-H])(\d{1,2})\b/gi;
  while ((m = wellRangeRegex.exec(str)) !== null) {
    const start = Math.max(1, Math.min(12, parseInt(m[2], 10)));
    const end = Math.max(1, Math.min(12, parseInt(m[4], 10)));
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    for (let c = lo; c <= hi; c++) cols.add(c);
  }

  // Single column mention e.g. "column 4", "col 12"
  const singleColRegex = /\bcol(?:umn)?\s*#?\s*(\d{1,2})\b/gi;
  while ((m = singleColRegex.exec(str)) !== null) {
    const c = parseInt(m[1], 10);
    if (c >= 1 && c <= 12) cols.add(c);
  }

  return Array.from(cols).sort((a, b) => a - b);
}

/**
 * Resolves the seeded columns (1..12, left to right) and seeded well coordinates (A1..H12)
 * for a 96-well plate seeding action.
 */
export function resolveSeededColumnsAndWells(
  seedData?: Partial<SeedReagentsActionData> | null,
  extraText?: string | null
): { seededColumns: number[]; seededWells: string[] } {
  const colsSet = new Set<number>();
  const wellsSet = new Set<string>();

  if (Array.isArray(seedData?.seededColumns)) {
    for (const c of seedData!.seededColumns!) {
      const n = Number(c);
      if (Number.isInteger(n) && n >= 1 && n <= 12) {
        colsSet.add(n);
      }
    }
  }

  if (Array.isArray(seedData?.seededWells)) {
    for (const w of seedData!.seededWells!) {
      const clean = String(w || '').trim().toUpperCase();
      const wm = clean.match(/^([A-H])(\d{1,2})$/);
      if (wm) {
        const colNum = parseInt(wm[2], 10);
        if (colNum >= 1 && colNum <= 12) {
          wellsSet.add(`${wm[1]}${colNum}`);
          colsSet.add(colNum);
        }
      }
    }
  }

  if (colsSet.size === 0) {
    const parsedFromText = parseColumnNumbersFromText(
      [seedData?.notes, extraText].filter(Boolean).join(' ')
    );
    for (const c of parsedFromText) colsSet.add(c);
  }

  // If still empty and seedingEventsCount > 0 on a 96-well plate, infer columns 1..min(12, count)
  const count = Number(seedData?.seedingEventsCount || 0);
  if (colsSet.size === 0 && count > 0) {
    const maxCol = Math.min(12, count);
    for (let c = 1; c <= maxCol; c++) {
      colsSet.add(c);
    }
  }

  const seededColumns = Array.from(colsSet).sort((a, b) => a - b);

  // Populate all 8 rows (A-H) for each seeded column if individual wells weren't restricted
  for (const col of seededColumns) {
    const hasSpecificWellInCol = Array.from(wellsSet).some((w) => {
      const m = w.match(/^[A-H](\d{1,2})$/);
      return m && parseInt(m[1], 10) === col;
    });
    if (!hasSpecificWellInCol) {
      for (const row of PLATE_96_ROWS) {
        wellsSet.add(`${row}${col}`);
      }
    }
  }

  const seededWells = Array.from(wellsSet);
  return { seededColumns, seededWells };
}

/**
 * Draws a 96-well plate diagram (rows A-H, columns 1-12 from left to right) for Markdown archive notes,
 * showing which wells/columns were seeded with cells.
 */
export function render96WellPlateMarkdown(
  seededColumns?: number[],
  seededWells?: string[]
): string {
  const { seededColumns: resolvedCols, seededWells: resolvedWells } = resolveSeededColumnsAndWells({
    seededColumns,
    seededWells,
  });
  const wellLookup = new Set(resolvedWells.map((w) => w.toUpperCase()));
  const colLookup = new Set(resolvedCols);

  const headerCols = PLATE_96_COLS.map((c) => String(c).padStart(3, ' ')).join('');
  const lines: string[] = [
    '96-Well Plate Map (Rows A–H, Columns 1–12 Left to Right):',
    `    ${headerCols}`,
    `   +${'-'.repeat(PLATE_96_COLS.length * 3 + 1)}+`,
  ];

  for (const row of PLATE_96_ROWS) {
    const cells = PLATE_96_COLS.map((col) => {
      const coord = `${row}${col}`;
      const isSeeded = wellLookup.has(coord) || (wellLookup.size === 0 && colLookup.has(col));
      return isSeeded ? '  ●' : '  ○';
    }).join('');
    lines.push(` ${row} |${cells} |`);
  }

  lines.push(`   +${'-'.repeat(PLATE_96_COLS.length * 3 + 1)}+`);
  lines.push(
    `Legend: ● = Seeded (${resolvedWells.length}/96 wells across ${resolvedCols.length}/12 columns) | ○ = Empty`
  );
  return lines.join('\n');
}

const OPERATOR_VERB_TO_GERUND: Record<string, string> = {
  pour: 'Pouring',
  pours: 'Pouring',
  poured: 'Pouring',
  pouring: 'Pouring',
  seed: 'Seeding',
  seeds: 'Seeding',
  seeded: 'Seeding',
  seeding: 'Seeding',
  mix: 'Mixing',
  mixes: 'Mixing',
  mixed: 'Mixing',
  mixing: 'Mixing',
  dispense: 'Dispensing',
  dispenses: 'Dispensing',
  dispensed: 'Dispensing',
  dispensing: 'Dispensing',
  transfer: 'Transferring',
  transfers: 'Transferring',
  transferred: 'Transferring',
  transferring: 'Transferring',
  add: 'Adding',
  adds: 'Adding',
  added: 'Adding',
  adding: 'Adding',
  pipette: 'Pipetting',
  pipettes: 'Pipetting',
  pipetted: 'Pipetting',
  pipetting: 'Pipetting',
  prepare: 'Preparing',
  prepares: 'Preparing',
  prepared: 'Preparing',
  preparing: 'Preparing',
  dilute: 'Diluting',
  dilutes: 'Diluting',
  diluted: 'Diluting',
  diluting: 'Diluting',
  aspirate: 'Aspirating',
  aspirates: 'Aspirating',
  aspirated: 'Aspirating',
  aspirating: 'Aspirating',
  present: 'Presenting',
  presents: 'Presenting',
  presented: 'Presenting',
  presenting: 'Presenting',
  plate: 'Plating',
  plates: 'Plating',
  plated: 'Plating',
  plating: 'Plating',
  reconstitute: 'Reconstituting',
  reconstitutes: 'Reconstituting',
  reconstituted: 'Reconstituting',
  reconstituting: 'Reconstituting',
  invert: 'Inverting',
  inverts: 'Inverting',
  inverted: 'Inverting',
  inverting: 'Inverting',
  swirl: 'Swirling',
  swirls: 'Swirling',
  swirled: 'Swirling',
  swirling: 'Swirling',
  resuspend: 'Resuspending',
  resuspends: 'Resuspending',
  resuspended: 'Resuspending',
  resuspending: 'Resuspending',
  combine: 'Combining',
  combines: 'Combining',
  combined: 'Combining',
  combining: 'Combining',
  aliquot: 'Aliquoting',
  aliquots: 'Aliquoting',
  aliquoted: 'Aliquoting',
  aliquoting: 'Aliquoting',
  inoculate: 'Inoculating',
  inoculates: 'Inoculating',
  inoculated: 'Inoculating',
  inoculating: 'Inoculating',
  vortex: 'Vortexing',
  vortexes: 'Vortexing',
  vortexed: 'Vortexing',
  vortexing: 'Vortexing',
  perform: 'Performing',
  performs: 'Performing',
  performed: 'Performing',
  performing: 'Performing',
};

function verbToGerund(verb: string): string {
  const lower = verb.toLowerCase();
  if (OPERATOR_VERB_TO_GERUND[lower]) {
    return OPERATOR_VERB_TO_GERUND[lower];
  }
  if (lower.endsWith('ing')) {
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }
  let stem = lower;
  if (lower.endsWith('ies') && lower.length > 4) {
    stem = lower.slice(0, -3) + 'y';
  } else if (
    lower.endsWith('xes') ||
    lower.endsWith('ches') ||
    lower.endsWith('shes') ||
    lower.endsWith('sses') ||
    lower.endsWith('zes')
  ) {
    stem = lower.slice(0, -2);
  } else if (lower.endsWith('es') && lower.length > 3) {
    const withoutS = lower.slice(0, -1);
    if (withoutS.endsWith('e') && !withoutS.endsWith('ee')) {
      stem = withoutS.slice(0, -1);
    } else {
      stem = withoutS;
    }
  } else if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 2) {
    stem = lower.slice(0, -1);
  } else if (lower.endsWith('e') && !lower.endsWith('ee') && lower.length > 2) {
    stem = lower.slice(0, -1);
  }
  const gerund = `${stem}ing`;
  return gerund.charAt(0).toUpperCase() + gerund.slice(1);
}

/**
 * Converts third-person / passive descriptions such as "Operator pours..." or "Operator seeds..."
 * into active gerund phrasing such as "Pouring..." or "Seeding...".
 */
export function toActiveVoiceDescription(description?: string | null): string {
  if (!description || typeof description !== 'string') return '';
  const trimmed = description.trim();
  if (!trimmed) return '';

  // Match leading "(The )?operator (is |was )?<verb>\b"
  const leadingOperatorMatch = trimmed.match(
    /^(?:the\s+)?operator\s+(?:(?:is|was)\s+)?([a-zA-Z]+)\b(.*)$/i
  );
  if (leadingOperatorMatch) {
    const gerund = verbToGerund(leadingOperatorMatch[1]);
    return `${gerund}${leadingOperatorMatch[2]}`;
  }

  // Match leading bare/past verbs like "Pours ...", "Seeds ...", "Seeded ...", "Mixed ...", "Pour ...", "Seed ...", "Mix ..."
  const leadingVerbMatch = trimmed.match(
    /^(pours?|poured|seeds?|seeded|mix(?:es|ed)?|dispenses?|dispensed|transfers?|transferred|adds?|added|pipettes?|pipetted)\b(.*)$/i
  );
  if (leadingVerbMatch) {
    const gerund = verbToGerund(leadingVerbMatch[1]);
    return `${gerund}${leadingVerbMatch[2]}`;
  }

  // Also replace any mid-sentence "operator <verb>s" occurrences
  return trimmed.replace(
    /\b(?:the\s+)?operator\s+(?:(?:is|was)\s+)?(pours?|poured|seeds?|seeded|mix(?:es|ed)?|dispenses?|dispensed|transfers?|transferred|adds?|added|pipettes?|pipetted)\b/gi,
    (_full, verb: string) => verbToGerund(verb).toLowerCase()
  );
}

/**
 * Structured Work Step entry in the Experiment Archive Notebook.
 * Supports 'MIX_REAGENTS' (`REAGENT_MIXING_ACTION`) and 'SEED_REAGENTS' (`REAGENT_SEEDING_ACTION`).
 */
export const ArchiveWorkStepSchema = z.object({
  id: z.string().optional(),
  stepId: z.string().optional(),
  stepNumber: z.number().int().positive().optional(),
  actionId: z.string().optional(),
  actionType: z.enum([
    'MIX_REAGENTS',
    'SEED_REAGENTS',
    'REAGENT_MIXING_ACTION',
    'REAGENT_SEEDING_ACTION',
  ]),
  description: z.string().optional(),
  startTime: z.union([z.string(), z.number()]).optional(),
  endTime: z.union([z.string(), z.number()]).optional(),
  startTimeSeconds: z.number().optional(),
  endTimeSeconds: z.number().optional(),
  mixReagentsData: MixReagentsActionDataSchema.optional(),
  seedReagentsData: SeedReagentsActionDataSchema.optional(),
  videoId: z.string().optional(),
});
export type ArchiveWorkStep = z.infer<typeof ArchiveWorkStepSchema>;

export const ArchiveRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  organizationId: z.string().optional(),
  creatorName: z.string().nullable().optional(),
  creationDate: z.string().nullable().optional(),
  markdownDoc: z.string().default(''),
  videoIds: z.array(z.string()).default([]),
  reagents: z.array(ArchiveReagentSchema).default([]),
  labelTranscriptions: z.array(z.string()).default([]),
  workSteps: z.array(ArchiveWorkStepSchema).default([]),
  contentErased: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type ArchiveRecord = z.infer<typeof ArchiveRecordSchema>;

export const CreateArchiveInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  creatorName: z.string().nullable().optional(),
  creationDate: z.string().nullable().optional(),
  markdownDoc: z.string().optional(),
  videoId: z.string().optional(),
  reagents: z.array(ArchiveReagentSchema).optional(),
  labelTranscriptions: z.array(z.string()).optional(),
  workSteps: z.array(ArchiveWorkStepSchema).optional(),
});
export type CreateArchiveInput = z.infer<typeof CreateArchiveInputSchema>;
