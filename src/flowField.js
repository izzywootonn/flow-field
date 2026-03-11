/**
 * Returns the closest point [px, py] on segment (x1,y1)→(x2,y2) to point (cx, cy).
 */
export function closestPointOnSegment(cx, cy, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return [x1, y1];
  const t = Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / lenSq));
  return [x1 + t * dx, y1 + t * dy];
}

/**
 * Sample a cubic bezier into (n+1) points.
 * A.cp2 and B.cp1 are the control points for the segment A→B.
 */
export function sampleBezier(ax, ay, cp2x, cp2y, cp1x, cp1y, bx, by, n = 16) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    pts.push({
      x: mt*mt*mt*ax + 3*mt*mt*t*cp2x + 3*mt*t*t*cp1x + t*t*t*bx,
      y: mt*mt*mt*ay + 3*mt*mt*t*cp2y + 3*mt*t*t*cp1y + t*t*t*by,
    });
  }
  return pts;
}

/**
 * Accumulate curl contribution from a list of linearized sample points
 * into sumX/sumY (mutated via the returned object).
 */
function accumulateSegments(cx, cy, pts, falloffExp, pull, acc) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [px, py] = closestPointOnSegment(cx, cy, pts[i].x, pts[i].y, pts[i+1].x, pts[i+1].y);
    const ax = cx - px, ay = cy - py;
    const d = Math.hypot(ax, ay);
    if (d < 0.5) continue;
    const curlX = -ay / d, curlY = ax / d;
    const weight = pull / (Math.pow(d, falloffExp) + 1e-6);
    acc.x += curlX * weight;
    acc.y += curlY * weight;
  }
}

/**
 * Compute the curl/vortex flow angle and strength at canvas point (cx, cy)
 * from all sources.
 *
 * Sources: { type: 'point', x, y }
 *        | { type: 'line', points: [{ x, y, type: 'corner'|'smooth', cp1, cp2 }, ...] }
 */
export function computeCell(cx, cy, sources, falloffExp, pull = 50) {
  // Tiny background keeps a default direction when sources are far away,
  // making `pull` meaningful as a reach control.
  const acc = { x: 0.001, y: 0 };

  for (const src of sources) {
    if (src.type === 'point') {
      const ax = cx - src.x, ay = cy - src.y;
      const d = Math.hypot(ax, ay);
      if (d < 0.5) continue;
      const weight = pull / (Math.pow(d, falloffExp) + 1e-6);
      acc.x += (-ay / d) * weight;
      acc.y += ( ax / d) * weight;
    } else {
      for (let s = 0; s < src.points.length - 1; s++) {
        const A = src.points[s], B = src.points[s + 1];
        if (A.type === 'corner' && B.type === 'corner') {
          // Fast path: straight segment
          accumulateSegments(cx, cy, [A, B], falloffExp, pull, acc);
        } else {
          // Bezier: sample and linearise
          const pts = sampleBezier(A.x, A.y, A.cp2.x, A.cp2.y, B.cp1.x, B.cp1.y, B.x, B.y);
          accumulateSegments(cx, cy, pts, falloffExp, pull, acc);
        }
      }
    }
  }

  return { angle: Math.atan2(acc.y, acc.x), strength: Math.hypot(acc.x, acc.y) };
}

/**
 * Compute the maximum strength across a sample of cells (used for normalisation).
 */
export function computeMaxStrength(sources, falloffExp, canvasW, canvasH, pull = 50, sampleCount = 200) {
  if (sources.length === 0) return 1;
  let max = 0;
  for (let i = 0; i < sampleCount; i++) {
    const { strength } = computeCell(
      Math.random() * canvasW, Math.random() * canvasH,
      sources, falloffExp, pull
    );
    if (strength > max) max = strength;
  }
  return max || 1;
}
