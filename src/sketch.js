import { computeCell, computeMaxStrength, closestPointOnSegment } from './flowField.js';

// Hit-detection radii (px)
const POINT_HIT_R  = 14;
const HANDLE_HIT_R = 10;
const LINE_HIT_R   = 7;

/**
 * Factory for a p5 instance-mode sketch.
 * @param {() => object} getParams  Returns current control values
 * @param {() => string} getMode    Returns 'point' | 'line' | 'edit'
 */
export default function makeSketch(getParams, getMode) {
  return (p) => {
    // ── State ─────────────────────────────────────────────────────────────
    let sources = [];

    // Drawing state (point / line modes)
    let drawingLine = null;   // { points: [{x,y},{x,y}] } while dragging
    let dragStarted = false;
    let mouseDownX = 0;
    let mouseDownY = 0;

    // Edit mode state
    let selectedIdx    = -1;    // index in sources[]
    let selectedHandle = null;  // number (vertex idx) | 'body' | null
    let selectedSegIdx = -1;    // segment index for body-click vertex insert
    let editDragging   = false;
    let hoverIdx       = -1;
    let hoverHandle    = null;

    // Cached max strength for length normalisation
    let cachedMaxStrength = 1;

    // ── Setup ─────────────────────────────────────────────────────────────
    p.setup = () => {
      const { width, height } = getParams();
      p.createCanvas(width, height).parent('canvas-container');
      p.noLoop();
    };

    // ── Draw ──────────────────────────────────────────────────────────────
    p.draw = () => {
      const params = getParams();
      if (p.width !== params.width || p.height !== params.height) {
        p.resizeCanvas(params.width, params.height);
      }
      p.background(params.colorBg);
      drawField(params);
      drawSources(params);
      if (drawingLine) drawPreviewLine(drawingLine, params);
    };

    // ── Field rendering ───────────────────────────────────────────────────
    function drawField(params) {
      const { cols, rows, lineLength, lineWeight, falloff, lengthByDist, colorField } = params;
      const cellW = p.width / cols;
      const cellH = p.height / rows;

      p.strokeWeight(lineWeight);
      p.stroke(colorField);
      p.noFill();

      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
          const cx = (col + 0.5) * cellW;
          const cy = (row + 0.5) * cellH;

          if (sources.length === 0) {
            drawFieldLine(cx, cy, 0, lineLength);
            continue;
          }

          const { angle, strength } = computeCell(cx, cy, sources, falloff);
          const norm = Math.min(strength / cachedMaxStrength, 1);
          const len  = lineLength * (1 - lengthByDist + lengthByDist * norm);
          drawFieldLine(cx, cy, angle, len);
        }
      }
    }

    function drawFieldLine(cx, cy, angle, len) {
      const halfLen = len / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      p.line(cx - cos * halfLen, cy - sin * halfLen,
             cx + cos * halfLen, cy + sin * halfLen);
    }

    // ── Source rendering ──────────────────────────────────────────────────
    function drawSources({ colorSource }) {
      const inEdit = getMode() === 'edit';

      for (let i = 0; i < sources.length; i++) {
        const src       = sources[i];
        const isSelected = inEdit && i === selectedIdx;
        const isHovered  = inEdit && i === hoverIdx && !isSelected;
        const c = isSelected ? '#ffffff'
                : isHovered  ? colorSource + 'bb'
                : colorSource;

        p.stroke(c);
        p.noFill();

        if (src.type === 'point') {
          p.strokeWeight(isSelected ? 2.5 : 1.5);
          p.circle(src.x, src.y, isSelected ? 14 : 8);
          p.strokeWeight(0.5);
          p.circle(src.x, src.y, 3);
        } else {
          // Polyline segments
          p.strokeWeight(isSelected ? 2.5 : 2);
          for (let s = 0; s < src.points.length - 1; s++) {
            p.line(src.points[s].x, src.points[s].y,
                   src.points[s + 1].x, src.points[s + 1].y);
          }
          // Endpoint dots (always)
          p.fill(c);
          p.noStroke();
          p.circle(src.points[0].x, src.points[0].y, 5);
          p.circle(src.points[src.points.length - 1].x,
                   src.points[src.points.length - 1].y, 5);

          // Vertex handles in edit mode
          if (inEdit) {
            p.rectMode(p.CENTER);
            for (let h = 0; h < src.points.length; h++) {
              const isSelHandle = isSelected && h === selectedHandle;
              p.stroke(isSelHandle ? '#ffffff' : c);
              p.fill(isSelHandle ? '#ffffff' : 'transparent');
              p.strokeWeight(isSelHandle ? 2 : 1);
              p.rect(src.points[h].x, src.points[h].y, 8, 8);
            }
          }
        }
      }
    }

    function drawPreviewLine({ points }, { colorSource }) {
      p.stroke(colorSource + '88');
      p.strokeWeight(1.5);
      p.drawingContext.setLineDash([4, 4]);
      p.line(points[0].x, points[0].y, points[1].x, points[1].y);
      p.drawingContext.setLineDash([]);
    }

    // ── Hit detection ─────────────────────────────────────────────────────
    function hitTestSources(mx, my) {
      // Priority 1: line vertex handles
      for (let i = sources.length - 1; i >= 0; i--) {
        const src = sources[i];
        if (src.type !== 'line') continue;
        for (let h = 0; h < src.points.length; h++) {
          if (Math.hypot(mx - src.points[h].x, my - src.points[h].y) < HANDLE_HIT_R)
            return { idx: i, handle: h, segIdx: -1 };
        }
      }
      // Priority 2: point sources
      for (let i = sources.length - 1; i >= 0; i--) {
        const src = sources[i];
        if (src.type === 'point' &&
            Math.hypot(mx - src.x, my - src.y) < POINT_HIT_R)
          return { idx: i, handle: -1, segIdx: -1 };
      }
      // Priority 3: line bodies
      for (let i = sources.length - 1; i >= 0; i--) {
        const src = sources[i];
        if (src.type !== 'line') continue;
        for (let s = 0; s < src.points.length - 1; s++) {
          const [px, py] = closestPointOnSegment(
            mx, my,
            src.points[s].x, src.points[s].y,
            src.points[s + 1].x, src.points[s + 1].y
          );
          if (Math.hypot(mx - px, my - py) < LINE_HIT_R)
            return { idx: i, handle: 'body', segIdx: s };
        }
      }
      return { idx: -1, handle: null, segIdx: -1 };
    }

    // ── Mouse events ──────────────────────────────────────────────────────
    function isOverCanvas() {
      return p.mouseX >= 0 && p.mouseX <= p.width &&
             p.mouseY >= 0 && p.mouseY <= p.height;
    }

    p.mousePressed = () => {
      if (!isOverCanvas()) return;
      mouseDownX  = p.mouseX;
      mouseDownY  = p.mouseY;
      dragStarted = false;

      const mode = getMode();

      if (mode === 'edit') {
        const hit = hitTestSources(p.mouseX, p.mouseY);
        selectedIdx    = hit.idx;
        selectedHandle = hit.handle;
        selectedSegIdx = hit.segIdx;
        editDragging   = false;
        p.redraw();
        return;
      }

      if (mode === 'line') {
        drawingLine = { points: [{ x: p.mouseX, y: p.mouseY }, { x: p.mouseX, y: p.mouseY }] };
      }
    };

    p.mouseDragged = () => {
      const mode = getMode();

      if (mode === 'edit') {
        if (selectedIdx < 0) return;
        const dx = p.mouseX - mouseDownX;
        const dy = p.mouseY - mouseDownY;
        if (Math.hypot(dx, dy) > 3) editDragging = true;
        if (!editDragging) return;

        const src = sources[selectedIdx];
        if (src.type === 'point') {
          src.x = p.mouseX;
          src.y = p.mouseY;
        } else if (typeof selectedHandle === 'number' && selectedHandle >= 0) {
          src.points[selectedHandle] = { x: p.mouseX, y: p.mouseY };
        }
        invalidateCache();
        p.redraw();
        return;
      }

      // Line drawing mode
      if (!isOverCanvas() && !drawingLine) return;
      const dx = p.mouseX - mouseDownX;
      const dy = p.mouseY - mouseDownY;
      if (Math.hypot(dx, dy) > 4) dragStarted = true;

      if (mode === 'line' && drawingLine) {
        drawingLine.points[1] = { x: p.mouseX, y: p.mouseY };
        p.redraw();
      }
    };

    p.mouseReleased = () => {
      const mode = getMode();

      if (mode === 'edit') {
        if (!editDragging && selectedIdx >= 0) {
          const src = sources[selectedIdx];
          // Click on line body → insert vertex at click position
          if (src.type === 'line' && selectedHandle === 'body' && selectedSegIdx >= 0) {
            src.points.splice(selectedSegIdx + 1, 0, { x: mouseDownX, y: mouseDownY });
            invalidateCache();
          }
        }
        editDragging = false;
        p.redraw();
        return;
      }

      if (mode === 'point') {
        if (!dragStarted && isOverCanvas()) {
          sources.push({ type: 'point', x: mouseDownX, y: mouseDownY });
          invalidateCache();
          p.redraw();
        }
      } else if (mode === 'line') {
        if (drawingLine) {
          const dx = drawingLine.points[1].x - drawingLine.points[0].x;
          const dy = drawingLine.points[1].y - drawingLine.points[0].y;
          if (Math.hypot(dx, dy) > 8) {
            sources.push({ type: 'line', points: [...drawingLine.points] });
            invalidateCache();
          }
          drawingLine = null;
          p.redraw();
        }
      }
      dragStarted = false;
    };

    p.mouseMoved = () => {
      if (getMode() !== 'edit') return;
      const hit = hitTestSources(p.mouseX, p.mouseY);
      if (hit.idx !== hoverIdx || hit.handle !== hoverHandle) {
        hoverIdx    = hit.idx;
        hoverHandle = hit.handle;
        p.redraw();
      }
    };

    p.keyPressed = () => {
      if (getMode() === 'edit' && selectedIdx >= 0 &&
          (p.key === 'Delete' || p.key === 'Backspace')) {
        sources.splice(selectedIdx, 1);
        selectedIdx    = -1;
        selectedHandle = null;
        invalidateCache();
        p.redraw();
        return false; // prevent browser back navigation on Backspace
      }
    };

    // ── Cache invalidation ────────────────────────────────────────────────
    function invalidateCache() {
      const { falloff } = getParams();
      cachedMaxStrength = computeMaxStrength(sources, falloff, p.width, p.height);
    }

    // ── Public API ────────────────────────────────────────────────────────
    p.addRandomSources = (n = 8) => {
      const w = p.width, h = p.height, margin = 40;
      for (let i = 0; i < n; i++) {
        if (Math.random() < 0.5) {
          sources.push({
            type: 'point',
            x: margin + Math.random() * (w - margin * 2),
            y: margin + Math.random() * (h - margin * 2),
          });
        } else {
          const cx    = margin + Math.random() * (w - margin * 2);
          const cy    = margin + Math.random() * (h - margin * 2);
          const angle = Math.random() * Math.PI * 2;
          const len   = 40 + Math.random() * 120;
          sources.push({
            type: 'line',
            points: [
              { x: cx - Math.cos(angle) * len / 2, y: cy - Math.sin(angle) * len / 2 },
              { x: cx + Math.cos(angle) * len / 2, y: cy + Math.sin(angle) * len / 2 },
            ],
          });
        }
      }
      invalidateCache();
      p.redraw();
    };

    p.clearSources = () => {
      sources        = [];
      selectedIdx    = -1;
      selectedHandle = null;
      cachedMaxStrength = 1;
      p.redraw();
    };

    p.invalidateCache  = invalidateCache;
    p.getSources       = () => sources;
    p.getMaxStrength   = () => cachedMaxStrength;
  };
}
