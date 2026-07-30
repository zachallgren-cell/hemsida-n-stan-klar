import type { ClarityDimension, ClaritySnapshot } from './clarity-types.ts';

export function selectMissingImportGroups(
  cached: ClaritySnapshot[],
  groups: ClarityDimension[][],
  nowMs: number,
  ttlMs: number
) {
  const freshKeys = new Set(cached
    .filter((snapshot) => nowMs - Date.parse(snapshot.fetched_at) < ttlMs)
    .map((snapshot) => snapshot.dimensions.join('|')));
  return groups.filter((group) => !freshKeys.has(group.join('|')));
}
