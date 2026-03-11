import { computeCell, computeMaxStrength, closestPointOnSegment, sampleBezier } from './flowField.js';

// Hit-detection radii (px)
const POINT_HIT_R  = 14;
const HANDLE_HIT_R = 10;
const CP_HIT_R     = 9;
const LINE_HIT_R   = 7;

// Off-canvas handle support
const EDIT_TOLERANCE   = 80;   // px beyond canvas edge still triggering edit mousePressed
const EDGE_INSET       = 8;    // px inset from canvas edge where indicator arrows are drawn
const DRAG_CANCEL_DIST = 120;  // px beyond canvas edge at which an active drag is cancelled

// ── Vertex helpers ────────────────────────────────────────────────────────────

/** Create a corner vertex at (x, y). */
function makeVertex(x, y) {
  return { x, y, type: 'corner', cp1: { x, y }, cp2: { x, y } };
}

/**
 * Auto-compute tangent handles for a vertex being switched to smooth.
 * Modifies the vertex in-place.
 */
function autoTangent(points, h) {
  const v    = points[h];
  const prev = h > 0               ? points[h - 1] : null;
  const next = h < points.length-1 ? points[h + 1] : null;

  let tx, ty;
  if (prev && next) {
    tx = next.x - prev.x; ty = next.y - prev.y;
  } else if (next) {
    tx = next.x - v.x;    ty = next.y - v.y;
  } else {
    tx = v.x - prev.x;    ty = v.y - prev.y;
  }
  const len = Math.hypot(tx, ty) || 1;
  tx /= len; ty /= len;

  const d1 = prev ? Math.hypot(v.x - prev.x, v.y - prev.y) / 3 : 40;
  const d2 = next ? Math.hypot(next.x - v.x, next.y - v.y) / 3 : 40;

  v.cp1  = { x: v.x - tx * d1, y: v.y - ty * d1 };
  v.cp2  = { x: v.x + tx * d2, y: v.y + ty * d2 };
  v.type = 'smooth';
}

// ── Bezier subdivision ────────────────────────────────────────────────────────

/**
 * Split bezier segment A→B at parameter t using de Casteljau.
 * Mutates A.cp2 and B.cp1 in-place. Returns new smooth midpoint vertex.
 */
function splitBezierAt(A, B, t) {
  const mt = 1 - t;
  const Q1 = { x: mt*A.x     + t*A.cp2.x, y: mt*A.y     + t*A.cp2.y };
  const Q2 = { x: mt*A.cp2.x + t*B.cp1.x, y: mt*A.cp2.y + t*B.cp1.y };
  const Q3 = { x: mt*B.cp1.x + t*B.x,     y: mt*B.cp1.y + t*B.y     };
  const R1 = { x: mt*Q1.x    + t*Q2.x,    y: mt*Q1.y    + t*Q2.y    };
  const R2 = { x: mt*Q2.x    + t*Q3.x,    y: mt*Q2.y    + t*Q3.y    };
  const M  = { x: mt*R1.x    + t*R2.x,    y: mt*R1.y    + t*R2.y    };
  A.cp2 = Q1;
  B.cp1 = Q3;
  return { x: M.x, y: M.y, type: 'smooth', cp1: R1, cp2: R2 };
}

// ── Off-canvas edge helpers ───────────────────────────────────────────────────

/**
 * Returns the clamped canvas-edge position for an off-canvas point,
 * plus whether it was actually off-canvas and the direction toward the real handle.
 * Must be called inside p5's context where p.width / p.height are available.
 */
function makeEdgePin(pWidth, pHeight) {
  return function edgePin(x, y) {
    const ex = Math.max(EDGE_INSET, Math.min(pWidth  - EDGE_INSET, x));
    const ey = Math.max(EDGE_INSET, Math.min(pHeight - EDGE_INSET, y));
    return { ex, ey, offCanvas: ex !== x || ey !== y, dx: x - ex, dy: y - ey };
  };
}

// ── Sketch factory ────────────────────────────────────────────────────────────

/**
 * @param {() => object}  getParams      Returns current control values
 * @param {() => string}  getMode        Returns 'point' | 'line' | 'edit'
 * @param {() => boolean} getShowSources Returns whether to render source markers
 */
export default function makeSketch(getParams, getMode, getShowSources = () => true, setMode = () => {}, getReturnMode = () => 'point', isActive = () => true) {
  return (p) => {
    // ── State ───────────────────────────────────────────────────────────────
    let sources = [];

    // ── Chaos mode ──────────────────────────────────────────────────────────
    let chaosMode   = false;
    let chaosAngles = [];   // flat [col * rows + row], length = cols × rows

    function generateChaosAngles(cols, rows) {
      chaosAngles = Array.from({ length: cols * rows }, () => Math.random() * Math.PI * 2);
    }

    // ── Undo / Redo ─────────────────────────────────────────────────────────
    let undoStack = [];
    let redoStack = [];

    function saveState() {
      undoStack.push(JSON.parse(JSON.stringify(sources)));
      redoStack = [];
    }

    function restoreState(snapshot) {
      sources.length = 0;
      snapshot.forEach(s => sources.push(s));
      selectedIdx    = -1;
      selectedHandle = null;
      multiSelected.clear();
      groupDragOrigins = null;
      invalidateCache();
      p.redraw();
    }

    // Drawing state
    let drawingLine = null;
    let previewPt   = null;   // cursor position for rubber-band preview
    let dragStarted = false;
    let mouseDownX  = 0;
    let mouseDownY  = 0;

    // Edit state
    // selectedHandle: null | -1 (point src) | { kind:'vertex'|'cp1'|'cp2'|'body', h, segIdx }
    let selectedIdx    = -1;
    let selectedHandle = null;
    let editDragging   = false;
    let hoverIdx       = -1;
    let hoverHandle    = null;

    // Marquee / multi-select state
    let mouseDownOnEmpty = false;  // mousedown hit empty space (potential marquee)
    let marqueeActive    = false;  // rubber-band rect currently being drawn
    let marqueeStart     = { x: 0, y: 0 };
    let marqueeEnd       = { x: 0, y: 0 };
    let multiSelected    = new Map();  // sourceIdx → Set<vertexIdx> | null (null = whole point source)
    let groupDragOrigins = null;       // {idx → deep-cloned source} snapshot at group-drag start

    let cachedMaxStrength = 1;

    // ── Setup ───────────────────────────────────────────────────────────────
    p.setup = () => {
      const { width, height } = getParams();
      p.createCanvas(width, height).parent('canvas-container');
      p.noLoop();
    };

    // ── Draw ────────────────────────────────────────────────────────────────
    p.draw = () => {
      const params = getParams();
      if (p.width !== params.width || p.height !== params.height) {
        p.resizeCanvas(params.width, params.height);
      }
      p.background(params.colorBg);
      drawField(params);
      if (getShowSources()) drawSources(params);
      if (drawingLine) drawPreviewLine(drawingLine, params);
      if (getMode() === 'edit') drawEdgeIndicators(params);
      if (getMode() === 'edit' && marqueeActive) drawMarqueeRect();
    };

    // ── Field rendering ─────────────────────────────────────────────────────
    function drawField(params) {
      const { cols, rows, lineLength, lineWeight, falloff, lengthByDist, pull, colorField } = params;
      const cellW = p.width / cols;
      const cellH = p.height / rows;

      // Regenerate chaos angles if grid size changed while in chaos mode
      if (chaosMode && chaosAngles.length !== cols * rows) {
        generateChaosAngles(cols, rows);
      }

      p.strokeWeight(lineWeight);
      p.stroke(colorField);
      p.noFill();

      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
          const cx = (col + 0.5) * cellW;
          const cy = (row + 0.5) * cellH;

          let angle, len;
          if (chaosMode) {
            angle = chaosAngles[col * rows + row];
            len   = lineLength;
          } else if (sources.length === 0) {
            angle = 0;
            len   = lineLength;
          } else {
            const { angle: a, strength } = computeCell(cx, cy, sources, falloff, pull);
            angle = a;
            const norm = Math.min(strength / cachedMaxStrength, 1);
            len = lineLength * (1 - lengthByDist + lengthByDist * norm);
          }
          drawFieldLine(cx, cy, angle, len);
        }
      }
    }

    function drawFieldLine(cx, cy, angle, len) {
      const h = len / 2, cos = Math.cos(angle), sin = Math.sin(angle);
      p.line(cx - cos*h, cy - sin*h, cx + cos*h, cy + sin*h);
    }

    // ── Source rendering ────────────────────────────────────────────────────
    function drawSources({ colorSource }) {
      const inEdit = getMode() === 'edit';

      for (let i = 0; i < sources.length; i++) {
        const src        = sources[i];
        const isSingleSel  = inEdit && i === selectedIdx;
        const inMultiSel   = inEdit && multiSelected.has(i);
        const multiVerts   = inMultiSel ? multiSelected.get(i) : null;
        // "fully selected" = single-select, or point source in multi-select,
        // or all vertices of a line source are in the selection
        const isFullySel   = isSingleSel ||
                             (inMultiSel && (src.type === 'point' || multiVerts === null ||
                              multiVerts.size === src.points.length));
        const isSelected   = isFullySel;   // kept for existing rendering logic below
        const isHovered    = inEdit && i === hoverIdx && !isFullySel && !inMultiSel;
        const c = isFullySel ? '#ffffff' : isHovered ? colorSource + 'bb' : colorSource;

        p.stroke(c);
        p.noFill();

        if (src.type === 'point') {
          p.strokeWeight(isSelected ? 2.5 : 1.5);
          p.circle(src.x, src.y, isSelected ? 14 : 8);
          p.strokeWeight(0.5);
          p.circle(src.x, src.y, 3);
        } else {
          // ── Draw polyline / bezier segments ──────────────────────────────
          p.strokeWeight(isSelected ? 2.5 : 2);
          for (let s = 0; s < src.points.length - 1; s++) {
            const A = src.points[s], B = src.points[s + 1];
            if (A.type === 'corner' && B.type === 'corner') {
              p.line(A.x, A.y, B.x, B.y);
            } else {
              p.noFill();
              p.bezier(A.x, A.y, A.cp2.x, A.cp2.y, B.cp1.x, B.cp1.y, B.x, B.y);
            }
          }

          // Endpoint dots
          p.fill(c); p.noStroke();
          p.circle(src.points[0].x, src.points[0].y, 5);
          p.circle(src.points[src.points.length-1].x, src.points[src.points.length-1].y, 5);

          // ── Edit mode overlays ───────────────────────────────────────────
          if (inEdit) {
            p.rectMode(p.CENTER);

            for (let h = 0; h < src.points.length; h++) {
              const v             = src.points[h];
              const isSelVtx      = (isSingleSel && selectedHandle?.kind === 'vertex' && selectedHandle.h === h) ||
                                    (inMultiSel  && multiVerts !== null && multiVerts.has(h));
              const vtxColor      = isSelVtx ? '#ffffff' : c;

              // Vertex square
              p.stroke(vtxColor);
              p.fill(isSelVtx ? '#ffffff' : 'transparent');
              p.strokeWeight(isSelVtx ? 2 : 1);
              p.rect(v.x, v.y, 8, 8);

              // Bezier handles (only for smooth vertices)
              if (v.type === 'smooth') {
                const showCp1 = h > 0;
                const showCp2 = h < src.points.length - 1;

                // Handle stems (thin lines from vertex to handle)
                p.strokeWeight(0.5);
                p.stroke(c + '77');
                p.noFill();
                if (showCp1) p.line(v.x, v.y, v.cp1.x, v.cp1.y);
                if (showCp2) p.line(v.x, v.y, v.cp2.x, v.cp2.y);

                // Handle circles
                p.strokeWeight(1);
                p.stroke(c);
                p.noFill();

                if (showCp1) {
                  const isSel = isSelected && selectedHandle?.kind === 'cp1' && selectedHandle.h === h;
                  if (isSel) { p.fill('#ffffff'); p.strokeWeight(2); }
                  p.circle(v.cp1.x, v.cp1.y, 7);
                  p.noFill(); p.strokeWeight(1);
                }
                if (showCp2) {
                  const isSel = isSelected && selectedHandle?.kind === 'cp2' && selectedHandle.h === h;
                  if (isSel) { p.fill('#ffffff'); p.strokeWeight(2); }
                  p.circle(v.cp2.x, v.cp2.y, 7);
                  p.noFill(); p.strokeWeight(1);
                }
              }
            }
          }
        }
      }
    }

    function drawPreviewLine({ points }, { colorSource }) {
      if (points.length === 0) return;
      p.stroke(colorSource + '88');
      p.strokeWeight(1.5);
      p.noFill();
      p.drawingContext.setLineDash([4, 4]);
      // Confirmed segments
      for (let s = 0; s < points.length - 1; s++) {
        p.line(points[s].x, points[s].y, points[s+1].x, points[s+1].y);
      }
      // Rubber-band to cursor
      if (previewPt) {
        const last = points[points.length - 1];
        p.line(last.x, last.y, previewPt.x, previewPt.y);
      }
      p.drawingContext.setLineDash([]);
      // Vertex dots
      p.fill(colorSource + '88'); p.noStroke();
      for (const pt of points) p.circle(pt.x, pt.y, 5);
    }

    // ── Off-canvas edge indicators ──────────────────────────────────────────
    function drawEdgeIndicators({ colorSource }) {
      const edgePin = makeEdgePin(p.width, p.height);

      function drawArrow(ex, ey, dx, dy, color, size = 8) {
        const angle = Math.atan2(dy, dx);
        p.push();
        p.translate(ex, ey);
        p.rotate(angle);
        p.fill(color);
        p.noStroke();
        p.triangle(size + 1, 0, -size / 2, size / 2 + 1, -size / 2, -(size / 2 + 1));
        p.pop();
      }

      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        const isSelected = i === selectedIdx;
        const color = isSelected ? '#ffffff' : colorSource;

        if (src.type === 'point') {
          const { ex, ey, offCanvas, dx, dy } = edgePin(src.x, src.y);
          if (offCanvas) drawArrow(ex, ey, dx, dy, color);
        } else {
          for (let h = 0; h < src.points.length; h++) {
            const v = src.points[h];
            const vtxPin = edgePin(v.x, v.y);
            if (vtxPin.offCanvas) drawArrow(vtxPin.ex, vtxPin.ey, vtxPin.dx, vtxPin.dy, color, 7);

            if (v.type === 'smooth') {
              if (h > 0) {
                const cp1Pin = edgePin(v.cp1.x, v.cp1.y);
                if (cp1Pin.offCanvas) drawArrow(cp1Pin.ex, cp1Pin.ey, cp1Pin.dx, cp1Pin.dy, color + '99', 5);
              }
              if (h < src.points.length - 1) {
                const cp2Pin = edgePin(v.cp2.x, v.cp2.y);
                if (cp2Pin.offCanvas) drawArrow(cp2Pin.ex, cp2Pin.ey, cp2Pin.dx, cp2Pin.dy, color + '99', 5);
              }
            }
          }
        }
      }
    }

    // ── Marquee rect ────────────────────────────────────────────────────────
    function drawMarqueeRect() {
      p.noFill();
      p.stroke('#ffffff55');
      p.strokeWeight(1);
      p.rectMode(p.CORNER);  // reset from CENTER mode set by drawSources vertex squares
      p.drawingContext.setLineDash([4, 4]);
      p.rect(
        marqueeStart.x, marqueeStart.y,
        marqueeEnd.x - marqueeStart.x,
        marqueeEnd.y - marqueeStart.y
      );
      p.drawingContext.setLineDash([]);
    }

    // ── Hit detection ───────────────────────────────────────────────────────
    function hitTestSources(mx, my) {
      // Priority 0: bezier control handles (cp1 / cp2)
      for (let i = sources.length - 1; i >= 0; i--) {
        const src = sources[i];
        if (src.type !== 'line') continue;
        for (let h = 0; h < src.points.length; h++) {
          const v = src.points[h];
          if (v.type !== 'smooth') continue;
          if (h > 0 && Math.hypot(mx - v.cp1.x, my - v.cp1.y) < CP_HIT_R)
            return { idx: i, handle: { kind: 'cp1', h }, segIdx: -1 };
          if (h < src.points.length - 1 && Math.hypot(mx - v.cp2.x, my - v.cp2.y) < CP_HIT_R)
            return { idx: i, handle: { kind: 'cp2', h }, segIdx: -1 };
        }
      }
      // Priority 1: vertex squares
      for (let i = sources.length - 1; i >= 0; i--) {
        const src = sources[i];
        if (src.type !== 'line') continue;
        for (let h = 0; h < src.points.length; h++) {
          if (Math.hypot(mx - src.points[h].x, my - src.points[h].y) < HANDLE_HIT_R)
            return { idx: i, handle: { kind: 'vertex', h }, segIdx: -1 };
        }
      }
      // Priority 2: point sources
      for (let i = sources.length - 1; i >= 0; i--) {
        if (sources[i].type === 'point' &&
            Math.hypot(mx - sources[i].x, my - sources[i].y) < POINT_HIT_R)
          return { idx: i, handle: -1, segIdx: -1 };
      }
      // Priority 3: line bodies
      for (let i = sources.length - 1; i >= 0; i--) {
        const src = sources[i];
        if (src.type !== 'line') continue;
        for (let s = 0; s < src.points.length - 1; s++) {
          const A = src.points[s], B = src.points[s + 1];
          const isBezier = !(A.type === 'corner' && B.type === 'corner');
          if (!isBezier) {
            const [px, py] = closestPointOnSegment(mx, my, A.x, A.y, B.x, B.y);
            if (Math.hypot(mx - px, my - py) < LINE_HIT_R)
              return { idx: i, handle: { kind: 'body', segIdx: s, t: 0.5 }, segIdx: s };
          } else {
            const samples = sampleBezier(A.x, A.y, A.cp2.x, A.cp2.y, B.cp1.x, B.cp1.y, B.x, B.y, 32);
            let minDist = Infinity, bestT = 0.5;
            for (let k = 0; k < samples.length; k++) {
              const d = Math.hypot(mx - samples[k].x, my - samples[k].y);
              if (d < minDist) { minDist = d; bestT = k / (samples.length - 1); }
            }
            if (minDist < LINE_HIT_R)
              return { idx: i, handle: { kind: 'body', segIdx: s, t: bestT }, segIdx: s };
          }
        }
      }
      // Priority 4: edge-pinned indicators for off-canvas handles
      // Allows clicking the arrow indicator to select a handle beyond the canvas
      {
        const edgePin = makeEdgePin(p.width, p.height);
        for (let i = sources.length - 1; i >= 0; i--) {
          const src = sources[i];
          if (src.type === 'point') {
            const { ex, ey, offCanvas } = edgePin(src.x, src.y);
            if (offCanvas && Math.hypot(mx - ex, my - ey) < POINT_HIT_R)
              return { idx: i, handle: -1, segIdx: -1 };
          } else {
            for (let h = 0; h < src.points.length; h++) {
              const v = src.points[h];
              const vtxPin = edgePin(v.x, v.y);
              if (vtxPin.offCanvas && Math.hypot(mx - vtxPin.ex, my - vtxPin.ey) < HANDLE_HIT_R)
                return { idx: i, handle: { kind: 'vertex', h }, segIdx: -1 };
              if (v.type === 'smooth') {
                if (h > 0) {
                  const cp1Pin = edgePin(v.cp1.x, v.cp1.y);
                  if (cp1Pin.offCanvas && Math.hypot(mx - cp1Pin.ex, my - cp1Pin.ey) < CP_HIT_R)
                    return { idx: i, handle: { kind: 'cp1', h }, segIdx: -1 };
                }
                if (h < src.points.length - 1) {
                  const cp2Pin = edgePin(v.cp2.x, v.cp2.y);
                  if (cp2Pin.offCanvas && Math.hypot(mx - cp2Pin.ex, my - cp2Pin.ey) < CP_HIT_R)
                    return { idx: i, handle: { kind: 'cp2', h }, segIdx: -1 };
                }
              }
            }
          }
        }
      }

      return { idx: -1, handle: null, segIdx: -1 };
    }

    /**
     * Return a Set of source indices whose anchor points (vertex / cp1 / cp2)
     * fall inside the given rectangle (coordinates auto-normalised).
     */
    function hitTestSourcesInRect(x1, y1, x2, y2) {
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
      const inBox = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
      // Returns Map<sourceIdx, Set<vertexIdx> | null>
      // Point sources: null (whole source). Line sources: Set of vertex indices inside the rect.
      const result = new Map();
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        if (src.type === 'point') {
          if (inBox(src.x, src.y)) result.set(i, null);
        } else {
          const verts = new Set();
          for (let h = 0; h < src.points.length; h++) {
            if (inBox(src.points[h].x, src.points[h].y)) verts.add(h);
          }
          if (verts.size > 0) result.set(i, verts);
        }
      }
      return result;
    }

    // ── Mouse events ────────────────────────────────────────────────────────
    function isOverCanvas() {
      return p.mouseX >= 0 && p.mouseX <= p.width &&
             p.mouseY >= 0 && p.mouseY <= p.height;
    }

    p.mousePressed = () => {
      if (!isActive()) return;
      // In edit mode allow grabbing handles slightly outside the canvas boundary
      const inBounds = getMode() === 'edit'
        ? (p.mouseX >= -EDIT_TOLERANCE && p.mouseX <= p.width  + EDIT_TOLERANCE &&
           p.mouseY >= -EDIT_TOLERANCE && p.mouseY <= p.height + EDIT_TOLERANCE)
        : isOverCanvas();
      if (!inBounds) {
        // Clicking outside the canvas while in edit mode exits edit cleanly,
        // so sidebar slider clicks don't accidentally distort anchor points.
        if (getMode() === 'edit') {
          multiSelected.clear();
          groupDragOrigins = null;
          setMode(getReturnMode());
          selectedIdx    = -1;
          selectedHandle = null;
          p.redraw();
        }
        return;
      }
      mouseDownX  = p.mouseX;
      mouseDownY  = p.mouseY;
      dragStarted = false;

      const mode = getMode();

      if (mode === 'edit') {
        const hit = hitTestSources(p.mouseX, p.mouseY);

        // Click on empty space → start potential marquee (defer exit to mouseReleased)
        if (hit.idx < 0) {
          mouseDownOnEmpty = true;
          marqueeActive    = false;
          marqueeStart     = { x: p.mouseX, y: p.mouseY };
          marqueeEnd       = { ...marqueeStart };
          selectedIdx    = -1;
          selectedHandle = null;
          p.redraw();
          return;
        }

        mouseDownOnEmpty = false;

        // If clicking a source that is already multi-selected → start group drag
        if (multiSelected.size > 0 && multiSelected.has(hit.idx)) {
          saveState();
          groupDragOrigins = {};
          for (const idx of multiSelected.keys()) {
            groupDragOrigins[idx] = JSON.parse(JSON.stringify(sources[idx]));
          }
          editDragging = false;
          p.redraw();
          return;
        }

        // Clicking a source not in multiSelected → clear multi-select, single-select
        multiSelected.clear();
        groupDragOrigins = null;

        // Save state before any drag — handle === -1 is a point source, body clicks
        // are handled in mouseReleased so we skip them here
        if (hit.handle === -1 || (hit.handle && hit.handle.kind !== 'body')) {
          saveState();
        }
        selectedIdx    = hit.idx;
        selectedHandle = hit.handle;
        editDragging   = false;
        p.redraw();
        return;
      }

      if (mode === 'line') {
        if (!drawingLine) {
          drawingLine = { points: [makeVertex(p.mouseX, p.mouseY)] };
        } else {
          drawingLine.points.push(makeVertex(p.mouseX, p.mouseY));
        }
        previewPt = { x: p.mouseX, y: p.mouseY };
        p.redraw();
      }
    };

    p.mouseDragged = () => {
      if (!isActive()) return;
      const mode = getMode();

      if (mode === 'edit') {
        // Marquee drag — mousedown was on empty space
        if (mouseDownOnEmpty) {
          if (Math.hypot(p.mouseX - mouseDownX, p.mouseY - mouseDownY) > 5) marqueeActive = true;
          if (marqueeActive) { marqueeEnd = { x: p.mouseX, y: p.mouseY }; p.redraw(); }
          return;
        }

        // Group drag — multi-selected sources moving together
        if (groupDragOrigins !== null) {
          if (Math.hypot(p.mouseX - mouseDownX, p.mouseY - mouseDownY) > 3) editDragging = true;
          if (!editDragging) return;
          const dx = p.mouseX - mouseDownX, dy = p.mouseY - mouseDownY;
          for (const [idx, vertexSet] of multiSelected) {
            const src    = sources[idx];
            const origin = groupDragOrigins[idx];
            if (src.type === 'point' || vertexSet === null) {
              // Move the whole point source
              src.x = origin.x + dx;
              src.y = origin.y + dy;
            } else {
              // Move only the selected vertices (and their control points)
              for (const h of vertexSet) {
                const v = src.points[h], ov = origin.points[h];
                v.x = ov.x + dx; v.y = ov.y + dy;
                v.cp1.x = ov.cp1.x + dx; v.cp1.y = ov.cp1.y + dy;
                v.cp2.x = ov.cp2.x + dx; v.cp2.y = ov.cp2.y + dy;
              }
            }
          }
          invalidateCache();
          p.redraw();
          return;
        }

        if (selectedIdx < 0) return;
        if (Math.hypot(p.mouseX - mouseDownX, p.mouseY - mouseDownY) > 3) editDragging = true;
        if (!editDragging) return;

        // Safety net: cancel drag if mouse strays far past the canvas edge
        // (e.g. accidentally dragging from canvas into sidebar in one motion)
        if (p.mouseX < -DRAG_CANCEL_DIST || p.mouseX > p.width  + DRAG_CANCEL_DIST ||
            p.mouseY < -DRAG_CANCEL_DIST || p.mouseY > p.height + DRAG_CANCEL_DIST) {
          if (undoStack.length) {
            const preDrag = undoStack.pop();
            sources.length = 0;
            preDrag.forEach(s => sources.push(s));
            redoStack = [];
          }
          editDragging   = false;
          selectedIdx    = -1;
          selectedHandle = null;
          invalidateCache();
          setMode(getReturnMode());
          p.redraw();
          return;
        }

        const src = sources[selectedIdx];
        const sh  = selectedHandle;

        if (sh === -1) {
          // Point source
          src.x = p.mouseX; src.y = p.mouseY;
        } else if (sh?.kind === 'vertex') {
          const v = src.points[sh.h];
          const dx = p.mouseX - v.x, dy = p.mouseY - v.y;
          v.x = p.mouseX; v.y = p.mouseY;
          v.cp1.x += dx; v.cp1.y += dy;
          v.cp2.x += dx; v.cp2.y += dy;
        } else if (sh?.kind === 'cp1') {
          const v = src.points[sh.h];
          v.cp1 = { x: p.mouseX, y: p.mouseY };
          v.cp2 = { x: 2*v.x - p.mouseX, y: 2*v.y - p.mouseY };
        } else if (sh?.kind === 'cp2') {
          const v = src.points[sh.h];
          v.cp2 = { x: p.mouseX, y: p.mouseY };
          v.cp1 = { x: 2*v.x - p.mouseX, y: 2*v.y - p.mouseY };
        }

        invalidateCache();
        p.redraw();
        return;
      }

      if (!isOverCanvas() && !drawingLine) return;
      if (Math.hypot(p.mouseX - mouseDownX, p.mouseY - mouseDownY) > 4) dragStarted = true;
    };

    p.mouseReleased = () => {
      if (!isActive()) return;
      const mode = getMode();

      if (mode === 'edit') {
        // Marquee release
        if (mouseDownOnEmpty) {
          mouseDownOnEmpty = false;
          if (marqueeActive) {
            multiSelected = hitTestSourcesInRect(
              marqueeStart.x, marqueeStart.y, marqueeEnd.x, marqueeEnd.y
            );
            marqueeActive = false;
            if (multiSelected.size === 0) setMode(getReturnMode()); // nothing caught → exit
            p.redraw();
          } else {
            // Short click on empty space → exit edit as before
            multiSelected.clear();
            setMode(getReturnMode());
            p.redraw();
          }
          return;
        }

        // Group drag release
        if (groupDragOrigins !== null) {
          groupDragOrigins = null;
          editDragging     = false;
          p.redraw();
          return;
        }

        if (!editDragging && selectedIdx >= 0) {
          const src = sources[selectedIdx];
          const sh  = selectedHandle;
          if (src.type === 'line' && sh?.kind === 'body') {
            saveState();
            const s = sh.segIdx;
            const A = src.points[s];
            const B = src.points[s + 1];
            const isBezier = !(A.type === 'corner' && B.type === 'corner');
            if (isBezier) {
              const newVtx = splitBezierAt(A, B, sh.t ?? 0.5);
              src.points.splice(s + 1, 0, newVtx);
            } else {
              src.points.splice(s + 1, 0, makeVertex(mouseDownX, mouseDownY));
            }
            invalidateCache();
          }
        }
        editDragging = false;
        p.redraw();
        return;
      }

      if (mode === 'point') {
        if (!dragStarted && isOverCanvas()) {
          // Don't add a new source if clicking on an existing one —
          // the doubleClicked handler will switch to edit mode instead
          if (hitTestSources(mouseDownX, mouseDownY).idx >= 0) return;
          saveState();
          sources.push({ type: 'point', x: mouseDownX, y: mouseDownY });
          invalidateCache();
          p.redraw();
        }
      }
      dragStarted = false;
    };

    p.doubleClicked = () => {
      if (!isActive()) return;
      const mode = getMode();

      // ── Point / Line mode: double-click an existing source to enter edit ──
      if (mode === 'point' || mode === 'line') {
        const hit = hitTestSources(p.mouseX, p.mouseY);
        if (hit.idx < 0) return;
        drawingLine    = null;
        previewPt      = null;
        setMode('edit');
        selectedIdx    = hit.idx;
        selectedHandle = hit.handle;
        editDragging   = false;
        p.redraw();
        return;
      }

      if (mode !== 'edit') return;
      const hit = hitTestSources(p.mouseX, p.mouseY);
      if (hit.idx < 0 || hit.handle?.kind !== 'vertex') return;
      saveState();
      const src = sources[hit.idx];
      const v   = src.points[hit.handle.h];
      if (v.type === 'smooth') {
        v.type = 'corner';
        v.cp1  = { x: v.x, y: v.y };
        v.cp2  = { x: v.x, y: v.y };
      } else {
        autoTangent(src.points, hit.handle.h);
      }
      invalidateCache();
      p.redraw();
    };

    p.mouseMoved = () => {
      if (!isActive()) return;
      if (getMode() === 'line' && drawingLine) {
        previewPt = { x: p.mouseX, y: p.mouseY };
        p.redraw();
        return;
      }
      if (getMode() !== 'edit') return;
      const hit = hitTestSources(p.mouseX, p.mouseY);
      if (hit.idx !== hoverIdx || hit.handle !== hoverHandle) {
        hoverIdx    = hit.idx;
        hoverHandle = hit.handle;
        p.redraw();
      }
    };

    p.keyPressed = () => {
      if (!isActive()) return false;
      if (getMode() === 'edit' && p.key === 'Escape') {
        multiSelected.clear();
        groupDragOrigins = null;
        setMode(getReturnMode());
        selectedIdx    = -1;
        selectedHandle = null;
        p.redraw();
        return false;
      }
      if (getMode() === 'line') {
        if (p.key === 'Enter' && drawingLine && drawingLine.points.length >= 2) {
          saveState();
          sources.push({ type: 'line', points: drawingLine.points });
          invalidateCache();
        }
        if (p.key === 'Enter' || p.key === 'Escape') {
          drawingLine = null;
          previewPt   = null;
          p.redraw();
        }
        return false;
      }
      if (getMode() === 'edit' && (p.key === 'Delete' || p.key === 'Backspace')) {
        // Multi-delete takes priority
        if (multiSelected.size > 0) {
          saveState();
          const toDelete = [];
          for (const [idx, vertexSet] of multiSelected) {
            const src = sources[idx];
            if (src.type === 'point' || vertexSet === null) {
              toDelete.push(idx);
            } else {
              // Remove selected vertices; if fewer than 2 remain, delete the whole line
              src.points = src.points.filter((_, h) => !vertexSet.has(h));
              if (src.points.length < 2) toDelete.push(idx);
            }
          }
          toDelete.sort((a, b) => b - a);
          for (const idx of toDelete) sources.splice(idx, 1);
          multiSelected.clear();
          selectedIdx    = -1;
          selectedHandle = null;
          invalidateCache();
          p.redraw();
          return false;
        }
        // Single-delete
        if (selectedIdx >= 0) {
          saveState();
          sources.splice(selectedIdx, 1);
          selectedIdx    = -1;
          selectedHandle = null;
          invalidateCache();
          p.redraw();
          return false;
        }
      }
    };

    // ── Cache ───────────────────────────────────────────────────────────────
    function invalidateCache() {
      const { falloff, pull } = getParams();
      cachedMaxStrength = computeMaxStrength(sources, falloff, p.width, p.height, pull);
    }

    // ── Public API ──────────────────────────────────────────────────────────
    p.addRandomSources = (n = 8) => {
      multiSelected.clear();
      groupDragOrigins = null;
      saveState();
      const w = p.width, h = p.height, margin = 40;
      for (let i = 0; i < n; i++) {
        if (Math.random() < 0.5) {
          sources.push({ type: 'point',
            x: margin + Math.random() * (w - margin*2),
            y: margin + Math.random() * (h - margin*2),
          });
        } else {
          const cx    = margin + Math.random() * (w - margin*2);
          const cy    = margin + Math.random() * (h - margin*2);
          const angle = Math.random() * Math.PI * 2;
          const len   = 40 + Math.random() * 120;
          sources.push({
            type: 'line',
            points: [
              makeVertex(cx - Math.cos(angle)*len/2, cy - Math.sin(angle)*len/2),
              makeVertex(cx + Math.cos(angle)*len/2, cy + Math.sin(angle)*len/2),
            ],
          });
        }
      }
      invalidateCache();
      p.redraw();
    };

    p.clearSources = () => {
      saveState();
      sources        = [];
      selectedIdx    = -1;
      selectedHandle = null;
      multiSelected.clear();
      groupDragOrigins = null;
      cachedMaxStrength = 1;
      p.redraw();
    };

    p.cancelDrawingLine = () => {
      drawingLine = null;
      previewPt   = null;
      p.redraw();
    };

    p.undo = () => {
      if (!undoStack.length) return;
      redoStack.push(JSON.parse(JSON.stringify(sources)));
      restoreState(undoStack.pop());
    };

    p.redo = () => {
      if (!redoStack.length) return;
      undoStack.push(JSON.parse(JSON.stringify(sources)));
      restoreState(redoStack.pop());
    };

    p.toggleChaos    = () => {
      chaosMode = !chaosMode;
      if (chaosMode) {
        const { cols, rows } = getParams();
        generateChaosAngles(cols, rows);
      }
      p.redraw();
    };
    p.getChaosMode   = () => chaosMode;
    p.getChaosAngles = () => chaosAngles;

    p.invalidateCache = invalidateCache;
    p.getSources      = () => sources;
    p.getMaxStrength  = () => cachedMaxStrength;
  };
}
