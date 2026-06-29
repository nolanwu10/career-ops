import { parseNormalizedJob, type NormalizedJob } from '@career-ops/shared-types';

export function normalizedJobFromStoredRecord(
  record: Record<string, unknown>
): NormalizedJob {
  const sourceIds = record.sourceIds instanceof Set
    ? [...record.sourceIds]
    : Array.isArray(record.sourceIds)
      ? record.sourceIds
      : [];

  return parseNormalizedJob({
    ...record,
    sourceId: record.sourceId ?? sourceIds[0],
    compensation: record.compensation ?? undefined,
    postedAt: record.postedAt ?? undefined,
    lastVerifiedAt: record.lastVerifiedAt ?? undefined
  });
}
