/**
 * Returns the closest point [px, py] on segment (x1,y1)→(x2,y2) to point (cx, cy),
 * and the distance from (cx, cy) to that point.
 */
export function closestPointOnSegment(cx, cy, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return [x1, y1]; // degenerate segment
  const t = Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / lenSq));
  return [x1 + t * dx, y1 + t * dy];
}

/**
 * Compute the curl/vortex flow angle and strength at canvas point (cx, cy)
 * from all sources.
 *
 * Each source creates a vortex: flow lines orbit around it (perpendicular
 * to the radial direction). Multiple sources combine additively.
 *
 * @param {number} cx
 * @param {number} cy
 * @param {Array} sources  Array of { type: 'point', x, y } or { type: 'line', points: [{x,y},...] }
 * @param {number} falloffExp  Exponent for inverse-distance weighting (higher = more local)
 * @returns {{ angle: number, strength: number }}
 */
export function computeCell(cx, cy, sources, falloffExp) {
  let sumX = 0;
  let sumY = 0;

  for (const src of sources) {
    if (src.type === 'point') {
      const ax = cx - src.x;
      const ay = cy - src.y;
      const d = Math.hypot(ax, ay);
      if (d < 0.5) continue;
      const curlX = -ay / d;
      const curlY =  ax / d;
      const weight = 1 / (Math.pow(d, falloffExp) + 1e-6);
      sumX += curlX * weight;
      sumY += curlY * weight;
    } else {
      // Polyline source: accumulate curl from every segment
      for (let s = 0; s < src.points.length - 1; s++) {
        const { x: ax1, y: ay1 } = src.points[s];
        const { x: ax2, y: ay2 } = src.points[s + 1];
        const [px, py] = closestPointOnSegment(cx, cy, ax1, ay1, ax2, ay2);
        const ax = cx - px;
        const ay = cy - py;
        const d = Math.hypot(ax, ay);
        if (d < 0.5) continue;
        const curlX = -ay / d;
        const curlY =  ax / d;
        const weight = 1 / (Math.pow(d, falloffExp) + 1e-6);
        sumX += curlX * weight;
        sumY += curlY * weight;
      }
    }
  }

  const angle = Math.atan2(sumY, sumX);
  const strength = Math.hypot(sumX, sumY);
  return { angle, strength };
}

/**
 * Compute the maximum strength across a sample of cells (used for normalization).
 * Sampling rather than exhaustive to keep it fast.
 */
export function computeMaxStrength(sources, falloffExp, canvasW, canvasH, sampleCount = 200) {
  if (sources.length === 0) return 1;
  let max = 0;
  for (let i = 0; i < sampleCount; i++) {
    const cx = Math.random() * canvasW;
    const cy = Math.random() * canvasH;
    const { strength } = computeCell(cx, cy, sources, falloffExp);
    if (strength > max) max = strength;
  }
  return max || 1;
}
