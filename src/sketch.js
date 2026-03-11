import { computeCell, computeMaxStrength } from './flowField.js';

// Accent color for sources (coral/orange)
const SOURCE_COLOR = [255, 110, 80];
const FIELD_COLOR = [190, 195, 220];

/**
 * Factory for a p5 instance-mode sketch.
 * @param {() => object} getParams  Returns current control values
 * @param {() => string} getMode    Returns 'point' | 'line'
 */
export default function makeSketch(getParams, getMode) {
  return (p) => {
    let sources = [];
    let drawingLine = null; // { x1, y1, x2, y2 } while dragging
    let dragStarted = false;
    let mouseDownX = 0;
    let mouseDownY = 0;

    // Cached max strength for normalization (recomputed when sources change)
    let cachedMaxStrength = 1;

    // ── Setup ─────────────────────────────────────────────────────────────
    p.setup = () => {
      const { width, height } = getParams();
      const canvas = p.createCanvas(width, height);
      canvas.parent('canvas-container');
      p.noLoop();
    };

    // ── Draw ──────────────────────────────────────────────────────────────
    p.draw = () => {
      const params = getParams();
      if (p.width !== params.width || p.height !== params.height) {
        p.resizeCanvas(params.width, params.height);
      }
      p.background(13, 13, 15);
      drawField(params);
      drawSources();
      if (drawingLine) drawPreviewLine(drawingLine);
    };

    // ── Field rendering ───────────────────────────────────────────────────
    function drawField(params) {
      const { cols, rows, lineLength, lineWeight, falloff, lengthByDist } = params;
      const cellW = p.width / cols;
      const cellH = p.height / rows;

      p.strokeWeight(lineWeight);
      p.stroke(...FIELD_COLOR);
      p.noFill();

      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < rows; row++) {
          const cx = (col + 0.5) * cellW;
          const cy = (row + 0.5) * cellH;

          if (sources.length === 0) {
            // Default: short horizontal ticks across the grid
            drawFieldLine(cx, cy, 0, lineLength);
            continue;
          }

          const { angle, strength } = computeCell(cx, cy, sources, falloff);
          const norm = Math.min(strength / cachedMaxStrength, 1);
          // Blend between base length and distance-scaled length
          const len = lineLength * (1 - lengthByDist + lengthByDist * norm);
          drawFieldLine(cx, cy, angle, len);
        }
      }
    }

    function drawFieldLine(cx, cy, angle, len) {
      const halfLen = len / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      p.line(
        cx - cos * halfLen,
        cy - sin * halfLen,
        cx + cos * halfLen,
        cy + sin * halfLen
      );
    }

    // ── Source rendering ──────────────────────────────────────────────────
    function drawSources() {
      for (const src of sources) {
        p.noFill();
        p.stroke(...SOURCE_COLOR);
        if (src.type === 'point') {
          p.strokeWeight(1.5);
          p.circle(src.x, src.y, 8);
          p.strokeWeight(0.5);
          p.circle(src.x, src.y, 3);
        } else {
          p.strokeWeight(2);
          p.line(src.x1, src.y1, src.x2, src.y2);
          // Endpoint dots
          p.fill(...SOURCE_COLOR);
          p.noStroke();
          p.circle(src.x1, src.y1, 5);
          p.circle(src.x2, src.y2, 5);
        }
      }
    }

    function drawPreviewLine({ x1, y1, x2, y2 }) {
      p.stroke(...SOURCE_COLOR, 120);
      p.strokeWeight(1.5);
      p.drawingContext.setLineDash([4, 4]);
      p.line(x1, y1, x2, y2);
      p.drawingContext.setLineDash([]);
    }

    // ── Mouse interaction ─────────────────────────────────────────────────
    function isOverCanvas() {
      return p.mouseX >= 0 && p.mouseX <= p.width && p.mouseY >= 0 && p.mouseY <= p.height;
    }

    p.mousePressed = () => {
      if (!isOverCanvas()) return;
      mouseDownX = p.mouseX;
      mouseDownY = p.mouseY;
      dragStarted = false;

      if (getMode() === 'line') {
        drawingLine = { x1: p.mouseX, y1: p.mouseY, x2: p.mouseX, y2: p.mouseY };
      }
    };

    p.mouseDragged = () => {
      if (!isOverCanvas() && !drawingLine) return;
      const dx = p.mouseX - mouseDownX;
      const dy = p.mouseY - mouseDownY;
      if (Math.hypot(dx, dy) > 4) dragStarted = true;

      if (getMode() === 'line' && drawingLine) {
        drawingLine.x2 = p.mouseX;
        drawingLine.y2 = p.mouseY;
        p.redraw();
      }
    };

    p.mouseReleased = () => {
      if (getMode() === 'point') {
        if (!dragStarted && isOnCanvasAt(mouseDownX, mouseDownY)) {
          sources.push({ type: 'point', x: mouseDownX, y: mouseDownY });
          invalidateCache();
          p.redraw();
        }
      } else {
        // Line mode
        if (drawingLine) {
          const dx = drawingLine.x2 - drawingLine.x1;
          const dy = drawingLine.y2 - drawingLine.y1;
          if (Math.hypot(dx, dy) > 8) {
            sources.push({ type: 'line', ...drawingLine });
            invalidateCache();
          }
          drawingLine = null;
          p.redraw();
        }
      }
      dragStarted = false;
    };

    function isOnCanvasAt(x, y) {
      return x >= 0 && x <= p.width && y >= 0 && y <= p.height;
    }

    // ── Cache invalidation ────────────────────────────────────────────────
    function invalidateCache() {
      const { falloff } = getParams();
      cachedMaxStrength = computeMaxStrength(sources, falloff, p.width, p.height);
    }

    // ── Public API (called from main.js) ──────────────────────────────────
    p.addRandomSources = (n = 8) => {
      const w = p.width;
      const h = p.height;
      const margin = 40;
      for (let i = 0; i < n; i++) {
        if (Math.random() < 0.5) {
          // Random point
          sources.push({
            type: 'point',
            x: margin + Math.random() * (w - margin * 2),
            y: margin + Math.random() * (h - margin * 2),
          });
        } else {
          // Random line segment
          const cx = margin + Math.random() * (w - margin * 2);
          const cy = margin + Math.random() * (h - margin * 2);
          const angle = Math.random() * Math.PI * 2;
          const len = 40 + Math.random() * 120;
          sources.push({
            type: 'line',
            x1: cx - Math.cos(angle) * len / 2,
            y1: cy - Math.sin(angle) * len / 2,
            x2: cx + Math.cos(angle) * len / 2,
            y2: cy + Math.sin(angle) * len / 2,
          });
        }
      }
      invalidateCache();
      p.redraw();
    };

    p.clearSources = () => {
      sources = [];
      cachedMaxStrength = 1;
      p.redraw();
    };

    p.invalidateCache = invalidateCache;
  };
}
