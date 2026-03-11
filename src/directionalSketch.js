import { closestPointOnSegment, sampleBezier } from './flowField.js';
import { computeDirectionalCell } from './directionalField.js';

// Hit-detection radii (px)
const POINT_HIT_R  = 14;
const HANDLE_HIT_R = 10;
const CP_HIT_R     = 9;
const LINE_HIT_R   = 7;

// Off-canvas handle support
const EDIT_TOLERANCE   = 80;   // px beyond canvas edge still triggering edit mousePressed
const EDGE_INSET       = 8;    // px inset from canvas edge where indicator arrows are drawn
const DRAG_CANCEL_DIST = 120;  // px beyond canvas edge at which an active drag is cancelled

// Angle handle (directional point sources only)
const ANGLE_HANDLE_LEN = 24;  // px from source centre to arrow tip
const ANGLE_HANDLE_R   = 6;   // hit radius of the draggable tip

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
 * @param {() => object}  getParams      Returns current control values (radius, feather, etc.)
 * @param {() => string}  getMode        Returns 'point' | 'line' | 'edit'
 * @param {() => boolean} getShowSources Returns whether to render source markers
 */
export default function makeDirectionalSketch(getParams, getMode, getShowSources = () => true, setMode = () => {}, getReturnMode = () => 'point') {
  return (p) => {
    // ── State ───────────────────────────────────────────────────────────────
    let sources = [];

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
      p.redraw();
    }

    // Drawing state
    let drawingLine = null;
    let previewPt   = null;
    let dragStarted = false;
    let mouseDownX  = 0;
    let mouseDownY  = 0;

    // Edit state
    let selectedIdx    = -1;
    let selectedHandle = null;
    let editDragging   = false;
    let hoverIdx       = -1;
    let hoverHandle    = null;

    // Marquee / multi-select state
    let mouseDownOnEmpty = false;
    let marqueeActive    = false;
    let marqueeStart     = { x: 0, y: 0 };
    let marqueeEnd       = { x: 0, y: 0 };
    let multiSelected    = new Map();  // sourceIdx → Set<vertexIdx> | null
    let groupDragOrigins = null;

    // ── Setup ───────────────────────────────────────────────────────────────
    p.setup = () => {
      const { width, height } = getParams();
      p.createCanvas(width, height).parent('canvas-container-directional');
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
      const { cols, rows, lineLength, lineWeight, radius, feather, colorField } = params;
      const cellW = p.width / cols, cellH = p.height / rows;
      p.strokeWeight(lineWeight);
      p.stroke(colorField);
      p.noFill();
      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
          const cx = (col + 0.5) * cellW, cy = (row + 0.5) * cellH;
          const angle = sources.length === 0
            ? 0
            : computeDirectionalCell(cx, cy, sources, radius, feather);
          drawFieldLine(cx, cy, angle, lineLength);
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
        const isFullySel   = isSingleSel ||
                             (inMultiSel && (src.type === 'point' || multiVerts === null ||
                              multiVerts.size === src.points.length));
        const isSelected   = isFullySel;
        const isHovered    = inEdit && i === hoverIdx && !isFullySel && !inMultiSel;
        const c = isFullySel ? '#ffffff' : isHovered ? colorSource + 'bb' : colorSource;

        p.stroke(c);
        p.noFill();

        if (src.type === 'point') {
          p.strokeWeight(isSelected ? 2.5 : 1.5);
          p.circle(src.x, src.y, isSelected ? 14 : 8);
          p.strokeWeight(0.5);
          p.circle(src.x, src.y, 3);

          // ── Angle stem + arrowhead (always visible) ──────────────────────
          const tipX = src.x + Math.cos(src.angle) * ANGLE_HANDLE_LEN;
          const tipY = src.y + Math.sin(src.angle) * ANGLE_HANDLE_LEN;
          p.strokeWeight(1.5); p.stroke(c);
          p.line(src.x, src.y, tipX, tipY);
          // Arrowhead triangle
          p.push();
          p.translate(tipX, tipY);
          p.rotate(src.angle);
          p.fill(c); p.noStroke();
          p.triangle(5, 0, -4, -3, -4, 3);
          p.pop();
          // Draggable handle circle at tip (edit mode only)
          if (inEdit) {
            const isAngleSel = isSingleSel && selectedHandle?.kind === 'angle';
            p.strokeWeight(isAngleSel ? 2 : 1);
            p.stroke(isAngleSel ? '#ffffff' : c);
            isAngleSel ? p.fill('#ffffff') : p.noFill();
            p.circle(tipX, tipY, ANGLE_HANDLE_R * 2);
          }
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
              const v        = src.points[h];
              const isSelVtx = (isSingleSel && selectedHandle?.kind === 'vertex' && selectedHandle.h === h) ||
                               (inMultiSel  && multiVerts !== null && multiVerts.has(h));
              const vtxColor = isSelVtx ? '#ffffff' : c;

              // Vertex square
              p.stroke(vtxColor);
              p.fill(isSelVtx ? '#ffffff' : 'transparent');
              p.strokeWeight(isSelVtx ? 2 : 1);
              p.rect(v.x, v.y, 8, 8);

              // Bezier handles (only for smooth vertices)
              if (v.type === 'smooth') {
                const showCp1 = h > 0;
                const showCp2 = h < src.points.length - 1;

                p.strokeWeight(0.5);
                p.stroke(c + '77');
                p.noFill();
                if (showCp1) p.line(v.x, v.y, v.cp1.x, v.cp1.y);
                if (showCp2) p.line(v.x, v.y, v.cp2.x, v.cp2.y);

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
      for (let s = 0; s < points.length - 1; s++) {
        p.line(points[s].x, points[s].y, points[s+1].x, points[s+1].y);
      }
      if (previewPt) {
        const last = points[points.length - 1];
        p.line(last.x, last.y, previewPt.x, previewPt.y);
      }
      p.drawingContext.setLineDash([]);
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
      p.rectMode(p.CORNER);
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
      // Priority 0: angle handles on directional point sources
      for (let i = sources.length - 1; i >= 0; i--) {
        const src = sources[i];
        if (src.type !== 'point') continue;
        const tipX = src.x + Math.cos(src.angle) * ANGLE_HANDLE_LEN;
        const tipY = src.y + Math.sin(src.angle) * ANGLE_HANDLE_LEN;
        if (Math.hypot(mx - tipX, my - tipY) < ANGLE_HANDLE_R)
          return { idx: i, handle: { kind: 'angle' }, segIdx: -1 };
      }
      // Priority 1: bezier control handles (cp1 / cp2)
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
      // Priority 2: vertex squares
      for (let i = sources.length - 1; i >= 0; i--) {
        const src = sources[i];
        if (src.type !== 'line') continue;
        for (let h = 0; h < src.points.length; h++) {
          if (Math.hypot(mx - src.points[h].x, my - src.points[h].y) < HANDLE_HIT_R)
            return { idx: i, handle: { kind: 'vertex', h }, segIdx: -1 };
        }
      }
      // Priority 3: point sources
      for (let i = sources.length - 1; i >= 0; i--) {
        if (sources[i].type === 'point' &&
            Math.hypot(mx - sources[i].x, my - sources[i].y) < POINT_HIT_R)
          return { idx: i, handle: -1, segIdx: -1 };
      }
      // Priority 4: line bodies
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
      // Priority 5: edge-pinned indicators for off-canvas handles
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
     * Returns Map<sourceIdx, Set<vertexIdx> | null> of sources hit by the rect.
     */
    function hitTestSourcesInRect(x1, y1, x2, y2) {
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
      const inBox = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
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
      const inBounds = getMode() === 'edit'
        ? (p.mouseX >= -EDIT_TOLERANCE && p.mouseX <= p.width  + EDIT_TOLERANCE &&
           p.mouseY >= -EDIT_TOLERANCE && p.mouseY <= p.height + EDIT_TOLERANCE)
        : isOverCanvas();
      if (!inBounds) {
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

        multiSelected.clear();
        groupDragOrigins = null;

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
      const mode = getMode();

      if (mode === 'edit') {
        // Marquee drag
        if (mouseDownOnEmpty) {
          if (Math.hypot(p.mouseX - mouseDownX, p.mouseY - mouseDownY) > 5) marqueeActive = true;
          if (marqueeActive) { marqueeEnd = { x: p.mouseX, y: p.mouseY }; p.redraw(); }
          return;
        }

        // Group drag
        if (groupDragOrigins !== null) {
          if (Math.hypot(p.mouseX - mouseDownX, p.mouseY - mouseDownY) > 3) editDragging = true;
          if (!editDragging) return;
          const dx = p.mouseX - mouseDownX, dy = p.mouseY - mouseDownY;
          for (const [idx, vertexSet] of multiSelected) {
            const src    = sources[idx];
            const origin = groupDragOrigins[idx];
            if (src.type === 'point' || vertexSet === null) {
              src.x = origin.x + dx;
              src.y = origin.y + dy;
            } else {
              for (const h of vertexSet) {
                const v = src.points[h], ov = origin.points[h];
                v.x = ov.x + dx; v.y = ov.y + dy;
                v.cp1.x = ov.cp1.x + dx; v.cp1.y = ov.cp1.y + dy;
                v.cp2.x = ov.cp2.x + dx; v.cp2.y = ov.cp2.y + dy;
              }
            }
          }
          p.redraw();
          return;
        }

        if (selectedIdx < 0) return;
        if (Math.hypot(p.mouseX - mouseDownX, p.mouseY - mouseDownY) > 3) editDragging = true;
        if (!editDragging) return;

        // Safety net: cancel drag if mouse strays far past the canvas edge
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
          setMode(getReturnMode());
          p.redraw();
          return;
        }

        const src = sources[selectedIdx];
        const sh  = selectedHandle;

        if (sh?.kind === 'angle') {
          // Drag the directional angle handle
          src.angle = Math.atan2(p.mouseY - src.y, p.mouseX - src.x);
        } else if (sh === -1) {
          // Point source body
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

        p.redraw();
        return;
      }

      if (!isOverCanvas() && !drawingLine) return;
      if (Math.hypot(p.mouseX - mouseDownX, p.mouseY - mouseDownY) > 4) dragStarted = true;
    };

    p.mouseReleased = () => {
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
            if (multiSelected.size === 0) setMode(getReturnMode());
            p.redraw();
          } else {
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
          }
        }
        editDragging = false;
        p.redraw();
        return;
      }

      if (mode === 'point') {
        if (!dragStarted && isOverCanvas()) {
          if (hitTestSources(mouseDownX, mouseDownY).idx >= 0) return;
          saveState();
          sources.push({ type: 'point', x: mouseDownX, y: mouseDownY, angle: 0 });
          p.redraw();
        }
      }
      dragStarted = false;
    };

    p.doubleClicked = () => {
      const mode = getMode();

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
      p.redraw();
    };

    p.mouseMoved = () => {
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
        }
        if (p.key === 'Enter' || p.key === 'Escape') {
          drawingLine = null;
          previewPt   = null;
          p.redraw();
        }
        return false;
      }
      if (getMode() === 'edit' && (p.key === 'Delete' || p.key === 'Backspace')) {
        if (multiSelected.size > 0) {
          saveState();
          const toDelete = [];
          for (const [idx, vertexSet] of multiSelected) {
            const src = sources[idx];
            if (src.type === 'point' || vertexSet === null) {
              toDelete.push(idx);
            } else {
              src.points = src.points.filter((_, h) => !vertexSet.has(h));
              if (src.points.length < 2) toDelete.push(idx);
            }
          }
          toDelete.sort((a, b) => b - a);
          for (const idx of toDelete) sources.splice(idx, 1);
          multiSelected.clear();
          selectedIdx    = -1;
          selectedHandle = null;
          p.redraw();
          return false;
        }
        if (selectedIdx >= 0) {
          saveState();
          sources.splice(selectedIdx, 1);
          selectedIdx    = -1;
          selectedHandle = null;
          p.redraw();
          return false;
        }
      }
    };

    // ── Public API ──────────────────────────────────────────────────────────
    p.addRandomSources = (n = 8) => {
      multiSelected.clear();
      groupDragOrigins = null;
      saveState();
      const w = p.width, h = p.height, margin = 40;
      for (let i = 0; i < n; i++) {
        if (Math.random() < 0.5) {
          sources.push({
            type: 'point',
            x: margin + Math.random() * (w - margin*2),
            y: margin + Math.random() * (h - margin*2),
            angle: Math.random() * Math.PI * 2,
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
      p.redraw();
    };

    p.clearSources = () => {
      saveState();
      sources        = [];
      selectedIdx    = -1;
      selectedHandle = null;
      multiSelected.clear();
      groupDragOrigins = null;
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

    p.getSources = () => sources;
  };
}
