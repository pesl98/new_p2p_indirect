/** Fields at or above this score are not highlighted in the finance inbox. */
export const LOW_CONFIDENCE_THRESHOLD = 0.8;

/**
 * A missing or non-numeric score is treated as low so the reviewer sees it.
 * The boundary is exclusive: 0.8 is not highlighted.
 */
export function isLowConfidence(confidence) {
  const score = Number(confidence);
  if (!Number.isFinite(score)) return true;
  return score < LOW_CONFIDENCE_THRESHOLD;
}
