import { closestPointOnSegment, sampleBezier } from './flowField.js';

/**
 * Compute the directional flow angle at canvas point (cx, cy)
 * from all sources. Each source contributes a directional vector weighted
 * by a feathered falloff over `radius` pixels — no curl, no repulsion.
 *
 * Returns the blended angle (atan2 of summed unit vectors), or 0 if no
 * contribution (e.g. no sources, or all sources out of radius).
 *
 * @param {number} cx           Cell centre x
 * @param {number} cy           Cell centre y
 * @param {Array}  sources      Array of source objects
 * @param {number} radius       Influence radius in pixels (default 150)
 * @param {number} feather      Falloff exponent — higher = sharper drop-off (default 1.5)
 */
export function computeDirectionalCell(cx, cy, sources, radius = 150, feather = 1.5) {
  let sumX = 0, sumY = 0;

  for (const src of sources) {
    if (src.type === 'point') {
      const d = Math.hypot(cx - src.x, cy - src.y);
      if (d > radius) continue;
      const w = Math.pow(Math.max(0, 1 - d / radius), feather);
      sumX += w * Math.cos(src.angle);
      sumY += w * Math.sin(src.angle);
    } else {
      // Line source: iterate each segment
      for (let s = 0; s < src.points.length - 1; s++) {
        const A = src.points[s], B = src.points[s + 1];

        if (A.type === 'corner' && B.type === 'corner') {
          // Straight segment: closest point + segment tangent
          const [px, py] = closestPointOnSegment(cx, cy, A.x, A.y, B.x, B.y);
          const d = Math.hypot(cx - px, cy - py);
          if (d > radius) continue;
          const w = Math.pow(Math.max(0, 1 - d / radius), feather);
          const segLen = Math.hypot(B.x - A.x, B.y - A.y);
          if (segLen < 1e-6) continue;
          sumX += w * (B.x - A.x) / segLen;
          sumY += w * (B.y - A.y) / segLen;
        } else {
          // Bezier segment: sample and find closest point, use central-difference tangent
          const samples = sampleBezier(A.x, A.y, A.cp2.x, A.cp2.y, B.cp1.x, B.cp1.y, B.x, B.y, 24);
          let minDist = Infinity, bestK = 0;
          for (let k = 0; k < samples.length; k++) {
            const d = Math.hypot(cx - samples[k].x, cy - samples[k].y);
            if (d < minDist) { minDist = d; bestK = k; }
          }
          if (minDist > radius) continue;
          const w = Math.pow(Math.max(0, 1 - minDist / radius), feather);
          const prev = Math.max(0, bestK - 1), next = Math.min(samples.length - 1, bestK + 1);
          if (prev === next) continue;
          const dtx = samples[next].x - samples[prev].x;
          const dty = samples[next].y - samples[prev].y;
          const dtLen = Math.hypot(dtx, dty);
          if (dtLen < 1e-6) continue;
          sumX += w * dtx / dtLen;
          sumY += w * dty / dtLen;
        }
      }
    }
  }

  return Math.hypot(sumX, sumY) < 1e-6 ? 0 : Math.atan2(sumY, sumX);
}
