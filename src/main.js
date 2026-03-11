import p5 from 'p5';
import makeSketch from './sketch.js';
import { exportSVG } from './exportSVG.js';

// ── Color picker references ───────────────────────────────────────────────────
const colorPickers = {
  colorBg:     document.getElementById('colorBg'),
  colorField:  document.getElementById('colorField'),
  colorSource: document.getElementById('colorSource'),
};

// ── Control references ────────────────────────────────────────────────────────
const sliders = {
  canvasWidth:  document.getElementById('canvasWidth'),
  canvasHeight: document.getElementById('canvasHeight'),
  cols:         document.getElementById('cols'),
  rows:         document.getElementById('rows'),
  lineLength:   document.getElementById('lineLength'),
  lineWeight:   document.getElementById('lineWeight'),
  falloff:      document.getElementById('falloff'),
  lengthByDist: document.getElementById('lengthByDist'),
};

const displays = {
  canvasWidth:  document.getElementById('canvasWidthVal'),
  canvasHeight: document.getElementById('canvasHeightVal'),
  cols:         document.getElementById('colsVal'),
  rows:         document.getElementById('rowsVal'),
  lineLength:   document.getElementById('lineLengthVal'),
  lineWeight:   document.getElementById('lineWeightVal'),
  falloff:      document.getElementById('falloffVal'),
  lengthByDist: document.getElementById('lengthByDistVal'),
};

// ── Mode state ────────────────────────────────────────────────────────────────
let currentMode = 'point';
const hintEl = document.getElementById('hint');

const HINTS = {
  point: 'Click to place a point source',
  line:  'Click and drag to draw a line source',
  edit:  'Click to select · Drag to move · Double-click vertex to toggle bezier · Delete to remove',
};

// ── Read params ───────────────────────────────────────────────────────────────
function getParams() {
  return {
    width:        parseInt(sliders.canvasWidth.value),
    height:       parseInt(sliders.canvasHeight.value),
    cols:         parseInt(sliders.cols.value),
    rows:         parseInt(sliders.rows.value),
    lineLength:   parseInt(sliders.lineLength.value),
    lineWeight:   parseFloat(sliders.lineWeight.value),
    falloff:      parseFloat(sliders.falloff.value),
    lengthByDist: parseFloat(sliders.lengthByDist.value),
    colorBg:      colorPickers.colorBg.value,
    colorField:   colorPickers.colorField.value,
    colorSource:  colorPickers.colorSource.value,
  };
}

function getMode() {
  return currentMode;
}

// ── Update display values ─────────────────────────────────────────────────────
function syncDisplays() {
  for (const [key, input] of Object.entries(sliders)) {
    const val = parseFloat(input.value);
    displays[key].textContent = Number.isInteger(val) ? val : val.toFixed(2);
  }
}

syncDisplays();

// ── p5 sketch ─────────────────────────────────────────────────────────────────
const sketch = new p5(makeSketch(getParams, getMode), document.getElementById('canvas-container'));

// ── Wire sliders → redraw ─────────────────────────────────────────────────────
for (const [key, input] of Object.entries(sliders)) {
  input.addEventListener('input', () => {
    syncDisplays();
    // Falloff change requires cache invalidation (strength normalisation)
    if (key === 'falloff') {
      sketch.invalidateCache();
    }
    sketch.redraw();
  });
}

// ── Mode buttons ──────────────────────────────────────────────────────────────
const modeButtons = ['modePoint', 'modeLine', 'modeEdit'];

function setMode(mode) {
  currentMode = mode;
  modeButtons.forEach(id => document.getElementById(id).classList.remove('active'));
  document.getElementById(`mode${mode.charAt(0).toUpperCase() + mode.slice(1)}`).classList.add('active');
  hintEl.textContent = HINTS[mode];
  sketch.redraw();
}

document.getElementById('modePoint').addEventListener('click', () => setMode('point'));
document.getElementById('modeLine').addEventListener('click',  () => setMode('line'));
document.getElementById('modeEdit').addEventListener('click',  () => setMode('edit'));

// ── Wire color pickers → redraw ───────────────────────────────────────────────
for (const picker of Object.values(colorPickers)) {
  picker.addEventListener('input', () => sketch.redraw());
}

// ── Action buttons ────────────────────────────────────────────────────────────
document.getElementById('randomize').addEventListener('click', () => {
  sketch.addRandomSources(8);
});

document.getElementById('exportSvg').addEventListener('click', () => {
  exportSVG(getParams(), sketch.getSources(), sketch.getMaxStrength());
});

document.getElementById('clear').addEventListener('click', () => {
  sketch.clearSources();
});
