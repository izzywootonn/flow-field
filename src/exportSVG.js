import { computeCell } from './flowField.js';

/**
 * Generate an SVG string of the current flow field and trigger a download.
 * @param {object} params     Current control params (including color values)
 * @param {Array}  sources    Array of point/line sources
 * @param {number} maxStrength  Cached max strength for length normalisation
 */
export function exportSVG(params, sources, maxStrength, showSources = true) {
  const {
    width, height, cols, rows,
    lineLength, lineWeight, falloff, lengthByDist,
    colorBg, colorField, colorSource,
  } = params;

  const cellW = width / cols;
  const cellH = height / rows;

  // ── Field lines ────────────────────────────────────────────────────────
  let fieldLines = '';
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      const cx = (col + 0.5) * cellW;
      const cy = (row + 0.5) * cellH;

      let angle = 0;
      let len = lineLength;

      if (sources.length > 0) {
        const { angle: a, strength } = computeCell(cx, cy, sources, falloff);
        angle = a;
        const norm = Math.min(strength / maxStrength, 1);
        len = lineLength * (1 - lengthByDist + lengthByDist * norm);
      }

      const halfLen = len / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const f = (n) => n.toFixed(2);
      fieldLines += `    <line x1="${f(cx - cos * halfLen)}" y1="${f(cy - sin * halfLen)}" x2="${f(cx + cos * halfLen)}" y2="${f(cy + sin * halfLen)}" />\n`;
    }
  }

  // ── Source markers ─────────────────────────────────────────────────────
  let sourceMarkers = '';
  for (const src of sources) {
    const f = (n) => n.toFixed(2);
    if (src.type === 'point') {
      sourceMarkers += `    <circle cx="${f(src.x)}" cy="${f(src.y)}" r="4" fill="none" stroke-width="1.5" />\n`;
      sourceMarkers += `    <circle cx="${f(src.x)}" cy="${f(src.y)}" r="1.5" />\n`;
    } else {
      // Build SVG path — L for corner-to-corner, C for bezier segments
      const first = src.points[0];
      let d = `M ${f(first.x)} ${f(first.y)}`;
      for (let s = 0; s < src.points.length - 1; s++) {
        const A = src.points[s], B = src.points[s + 1];
        if (A.type === 'corner' && B.type === 'corner') {
          d += ` L ${f(B.x)} ${f(B.y)}`;
        } else {
          d += ` C ${f(A.cp2.x)} ${f(A.cp2.y)} ${f(B.cp1.x)} ${f(B.cp1.y)} ${f(B.x)} ${f(B.y)}`;
        }
      }
      sourceMarkers += `    <path d="${d}" fill="none" stroke-width="2" />\n`;
      // Vertex dots
      for (const pt of src.points) {
        sourceMarkers += `    <circle cx="${f(pt.x)}" cy="${f(pt.y)}" r="2.5" />\n`;
      }
    }
  }

  // ── Assemble SVG ───────────────────────────────────────────────────────
  const sourcesGroup = showSources
    ? `  <g stroke="${colorSource}" fill="${colorSource}">\n${sourceMarkers}  </g>\n`
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${colorBg}" />
  <g stroke="${colorField}" stroke-width="${lineWeight}" stroke-linecap="round" fill="none">
${fieldLines}  </g>
${sourcesGroup}</svg>`;

  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'flow-field.svg';
  a.click();
  URL.revokeObjectURL(url);
}
