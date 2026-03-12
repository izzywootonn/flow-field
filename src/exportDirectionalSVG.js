import { computeDirectionalCell } from './directionalField.js';

/**
 * Generate an SVG of the directional flow field and trigger a download.
 * @param {object} params    Current directional params (width, height, cols, rows,
 *                           lineLength, lineWeight, radius, feather, colorBg, colorField, colorSource)
 * @param {Array}  sources   Array of point/line sources (point sources have an `angle` property)
 * @param {boolean} showSources  Whether to render source markers
 */
export function exportDirectionalSVG(params, sources, showSources = true) {
  const {
    width, height, cols, rows,
    lineLength, lineWeight, radius, feather,
    colorBg, colorField, colorSource,
  } = params;

  const cellW = width / cols;
  const cellH = height / rows;
  const f = (n) => n.toFixed(2);

  // ── Field lines (edge-anchored, matching canvas rendering) ─────────────
  let fieldLines = '';
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      const cx = (col + 0.5) * cellW;
      const cy = (row + 0.5) * cellH;
      const angle = sources.length === 0
        ? 0
        : computeDirectionalCell(cx, cy, sources, radius, feather);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      fieldLines += `    <line x1="${f(cx)}" y1="${f(cy)}" x2="${f(cx + cos * lineLength)}" y2="${f(cy + sin * lineLength)}" />\n`;
    }
  }

  // ── Source markers ─────────────────────────────────────────────────────
  let sourceMarkers = '';
  for (const src of sources) {
    if (src.type === 'point') {
      // Circle + dot
      sourceMarkers += `    <circle cx="${f(src.x)}" cy="${f(src.y)}" r="4" fill="none" stroke-width="1.5" />\n`;
      sourceMarkers += `    <circle cx="${f(src.x)}" cy="${f(src.y)}" r="1.5" />\n`;
      // Angle arrow stem + arrowhead
      const STEM = 24;
      const tipX = src.x + Math.cos(src.angle) * STEM;
      const tipY = src.y + Math.sin(src.angle) * STEM;
      sourceMarkers += `    <line x1="${f(src.x)}" y1="${f(src.y)}" x2="${f(tipX)}" y2="${f(tipY)}" stroke-width="1.5" />\n`;
      // Arrowhead: small triangle at tip
      const a = src.angle;
      const hw = 3, hl = 5;
      const ax = tipX + Math.cos(a) * hl, ay = tipY + Math.sin(a) * hl;
      const lx = tipX + Math.cos(a + Math.PI * 0.75) * hw * 1.5;
      const ly = tipY + Math.sin(a + Math.PI * 0.75) * hw * 1.5;
      const rx = tipX + Math.cos(a - Math.PI * 0.75) * hw * 1.5;
      const ry = tipY + Math.sin(a - Math.PI * 0.75) * hw * 1.5;
      sourceMarkers += `    <polygon points="${f(ax)},${f(ay)} ${f(lx)},${f(ly)} ${f(rx)},${f(ry)}" stroke="none" />\n`;
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
  a.download = 'flow-field-directional.svg';
  a.click();
  URL.revokeObjectURL(url);
}
