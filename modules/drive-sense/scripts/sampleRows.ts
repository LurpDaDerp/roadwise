// Sample `FeatureRow`s for the module's own tests, built from its golden vectors so the suites
// depend on nothing outside `modules/drive-sense` (the app's trace fixtures come and go with the
// drive pipeline). The rows carry the 21 contract keys only — the optional motion fields (C0) are
// stripped, as a pre-C0 native build or a stored row would present them.
import { MOTION_ROW_FIELDS } from '../src/rowSchema';
import type { ExtractVector } from '../src/extract/vectors';
import type { FeatureRow } from '../src/types';
import { VECTOR_BUILDERS } from './scenarios';

/** `n` valid rows with strictly increasing `ts` (1 s apart), cycling the cruise vector's rows. */
export function sampleRows(n: number): FeatureRow[] {
  const base = (VECTOR_BUILDERS.cruise() as ExtractVector).expected.rows;
  const first = base[0]!.ts;
  const out: FeatureRow[] = [];
  for (let i = 0; i < n; i++) {
    const row: FeatureRow = { ...base[i % base.length]!, ts: first + i * 1000 };
    for (const k of MOTION_ROW_FIELDS) delete row[k];
    out.push(row);
  }
  return out;
}
