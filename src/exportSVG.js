import { computeCell } from './flowField.js';

/**
 * Generate an SVG string of the current flow field and trigger a download.
 * @param {object} params     Current control params (including color values)
 * @param {Array}  sources    Array of point/line sources
 * @param {number} maxStrength  Cached max strength for length normalisation
 */
export function exportSVG(params, sources, maxStrength) {
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
      // Polyline: render each segment
      for (let s = 0; s < src.points.length - 1; s++) {
        const a = src.points[s], b = src.points[s + 1];
        sourceMarkers += `    <line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}" stroke-width="2" />\n`;
      }
      // All vertex dots
      for (const pt of src.points) {
        sourceMarkers += `    <circle cx="${f(pt.x)}" cy="${f(pt.y)}" r="2.5" />\n`;
      }
    }
  }

  // ── Assemble SVG ───────────────────────────────────────────────────────
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${colorBg}" />
  <g stroke="${colorField}" stroke-width="${lineWeight}" stroke-linecap="round" fill="none">
${fieldLines}  </g>
  <g stroke="${colorSource}" fill="${colorSource}">
${sourceMarkers}  </g>
</svg>`;

  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'flow-field.svg';
  a.click();
  URL.revokeObjectURL(url);
}
