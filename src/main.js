import p5 from 'p5';
import makeSketch from './sketch.js';
import makeDirectionalSketch from './directionalSketch.js';
import { exportSVG } from './exportSVG.js';
import { exportDirectionalSVG } from './exportDirectionalSVG.js';

// ── Color picker references ───────────────────────────────────────────────────
const colorPickers = {
  colorBg:     document.getElementById('colorBg'),
  colorField:  document.getElementById('colorField'),
  colorSource: document.getElementById('colorSource'),
};

// ── Slider references ─────────────────────────────────────────────────────────
// Shared sliders are in magneticSliders but drive both sketches on change.
const magneticSliders = {
  canvasWidth:  document.getElementById('canvasWidth'),
  canvasHeight: document.getElementById('canvasHeight'),
  cols:         document.getElementById('cols'),
  rows:         document.getElementById('rows'),
  lineLength:   document.getElementById('lineLength'),
  lineWeight:   document.getElementById('lineWeight'),
  falloff:      document.getElementById('falloff'),
  lengthByDist: document.getElementById('lengthByDist'),
  pull:         document.getElementById('pull'),
};

const directionalSliders = {
  radius:  document.getElementById('radius'),
  feather: document.getElementById('feather'),
};

// Magnetic-only slider keys (do NOT redraw directional sketch)
const magneticOnlyKeys = new Set(['falloff', 'lengthByDist', 'pull']);

const displays = {
  canvasWidth:  document.getElementById('canvasWidthVal'),
  canvasHeight: document.getElementById('canvasHeightVal'),
  cols:         document.getElementById('colsVal'),
  rows:         document.getElementById('rowsVal'),
  lineLength:   document.getElementById('lineLengthVal'),
  lineWeight:   document.getElementById('lineWeightVal'),
  falloff:      document.getElementById('falloffVal'),
  lengthByDist: document.getElementById('lengthByDistVal'),
  pull:         document.getElementById('pullVal'),
  radius:       document.getElementById('radiusVal'),
  feather:      document.getElementById('featherVal'),
};

// ── Mode / tab state ──────────────────────────────────────────────────────────
let currentMode  = 'point';
let prevMode     = 'point';   // last non-edit mode; restored when exiting edit
let showSources  = true;
let activeTab    = 'magnetic';

const hintEl = document.getElementById('hint');

const HINTS = {
  point: 'Click to place a point source',
  line:  'Click to place points · Enter to finish · Escape to cancel',
  edit:  'Click to select · Drag empty space to multi-select · Drag to move · Double-click vertex to toggle bezier · Delete to remove',
};

// ── Read params ───────────────────────────────────────────────────────────────
function getSharedParams() {
  return {
    width:       parseInt(magneticSliders.canvasWidth.value),
    height:      parseInt(magneticSliders.canvasHeight.value),
    cols:        parseInt(magneticSliders.cols.value),
    rows:        parseInt(magneticSliders.rows.value),
    lineLength:  parseInt(magneticSliders.lineLength.value),
    lineWeight:  parseFloat(magneticSliders.lineWeight.value),
    colorBg:     colorPickers.colorBg.value,
    colorField:  colorPickers.colorField.value,
    colorSource: colorPickers.colorSource.value,
  };
}

function getParams() {
  return {
    ...getSharedParams(),
    falloff:      parseFloat(magneticSliders.falloff.value),
    lengthByDist: parseFloat(magneticSliders.lengthByDist.value),
    pull:         parseFloat(magneticSliders.pull.value),
  };
}

function getDirectionalParams() {
  return {
    ...getSharedParams(),
    radius:  parseFloat(directionalSliders.radius.value),
    feather: parseFloat(directionalSliders.feather.value),
  };
}

function getMode()        { return currentMode; }
function getShowSources() { return showSources; }

// ── Update display values ─────────────────────────────────────────────────────
function syncDisplays() {
  const allSliders = { ...magneticSliders, ...directionalSliders };
  for (const [key, input] of Object.entries(allSliders)) {
    if (!input || !displays[key]) continue;
    const val = parseFloat(input.value);
    displays[key].textContent = Number.isInteger(val) ? val : val.toFixed(2);
  }
}

syncDisplays();

// ── p5 sketches ───────────────────────────────────────────────────────────────
const sketch = new p5(
  makeSketch(getParams, getMode, getShowSources, setMode, getReturnMode,
    () => activeTab === 'magnetic'),
  document.getElementById('canvas-container')
);

const directionalSketch = new p5(
  makeDirectionalSketch(getDirectionalParams, getMode, getShowSources, setMode, getReturnMode,
    () => activeTab === 'directional'),
  document.getElementById('canvas-container-directional')
);

function getActiveSketch() {
  return activeTab === 'magnetic' ? sketch : directionalSketch;
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  prevMode  = 'point';  // reset so exiting edit on the new tab returns to point

  // Toggle canvas visibility
  document.getElementById('canvas-container').style.display =
    tab === 'magnetic' ? '' : 'none';
  document.getElementById('canvas-container-directional').style.display =
    tab === 'directional' ? '' : 'none';

  // Toggle sidebar section visibility
  const magneticControls    = document.getElementById('magnetic-controls');
  const directionalControls = document.getElementById('directional-controls');
  const magneticActions     = document.getElementById('magnetic-actions');
  const magneticExport      = document.getElementById('magnetic-export');
  const directionalExport   = document.getElementById('directional-export');

  if (magneticControls)    magneticControls.style.display    = tab === 'magnetic'    ? '' : 'none';
  if (directionalControls) directionalControls.style.display = tab === 'directional' ? '' : 'none';
  if (magneticActions)     magneticActions.style.display     = tab === 'magnetic'    ? '' : 'none';
  if (magneticExport)      magneticExport.style.display      = tab === 'magnetic'    ? '' : 'none';
  if (directionalExport)   directionalExport.style.display   = tab === 'directional' ? '' : 'none';

  // Update tab button active states
  document.getElementById('tabMagnetic').classList.toggle('active',    tab === 'magnetic');
  document.getElementById('tabDirectional').classList.toggle('active', tab === 'directional');

  // Cancel any active line drawing and reset to point mode
  getActiveSketch().cancelDrawingLine();
  setMode('point');
}

document.getElementById('tabMagnetic').addEventListener('click',    () => switchTab('magnetic'));
document.getElementById('tabDirectional').addEventListener('click', () => switchTab('directional'));

// ── Wire sliders → redraw ─────────────────────────────────────────────────────
// Magnetic sliders: shared sliders redraw both; magnetic-only sliders redraw only magnetic
for (const [key, input] of Object.entries(magneticSliders)) {
  if (!input) continue;
  const isMagneticOnly = magneticOnlyKeys.has(key);
  input.addEventListener('input', () => {
    syncDisplays();
    if (key === 'falloff' || key === 'pull') sketch.invalidateCache();
    sketch.redraw();
    if (!isMagneticOnly) directionalSketch.redraw();
  });
  input.addEventListener('dblclick', () => {
    input.value = input.defaultValue;
    syncDisplays();
    if (key === 'falloff' || key === 'pull') sketch.invalidateCache();
    sketch.redraw();
    if (!isMagneticOnly) directionalSketch.redraw();
  });
}

// Directional-only sliders: redraw only directional sketch
for (const [key, input] of Object.entries(directionalSliders)) {
  if (!input) continue;
  input.addEventListener('input', () => {
    syncDisplays();
    directionalSketch.redraw();
  });
  input.addEventListener('dblclick', () => {
    input.value = input.defaultValue;
    syncDisplays();
    directionalSketch.redraw();
  });
}

// ── Mode buttons ──────────────────────────────────────────────────────────────
const modeButtons = ['modePoint', 'modeLine', 'modeEdit'];

function setMode(mode) {
  if (mode === 'edit' && currentMode !== 'edit') prevMode = currentMode;
  currentMode = mode;
  modeButtons.forEach(id => document.getElementById(id).classList.remove('active'));
  document.getElementById(`mode${mode.charAt(0).toUpperCase() + mode.slice(1)}`).classList.add('active');
  hintEl.textContent = HINTS[mode];
  sketch.redraw();
  directionalSketch.redraw();
}

function getReturnMode() { return prevMode; }

document.getElementById('modePoint').addEventListener('click', () => { getActiveSketch().cancelDrawingLine(); setMode('point'); });
document.getElementById('modeLine').addEventListener('click',  () => { getActiveSketch().cancelDrawingLine(); setMode('line');  });
document.getElementById('modeEdit').addEventListener('click',  () => { getActiveSketch().cancelDrawingLine(); setMode('edit');  });

// ── Wire color pickers → redraw ───────────────────────────────────────────────
for (const picker of Object.values(colorPickers)) {
  picker.addEventListener('input', () => {
    sketch.redraw();
    directionalSketch.redraw();
  });
}

// ── Action buttons ────────────────────────────────────────────────────────────
document.getElementById('randomize').addEventListener('click', () => {
  getActiveSketch().addRandomSources(8);
});

function downloadCanvasPng(canvas, filename) {
  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

document.getElementById('exportSvg').addEventListener('click', () => {
  exportSVG(getParams(), sketch.getSources(), sketch.getMaxStrength(), showSources, sketch.getChaosMode(), sketch.getChaosAngles());
});

document.getElementById('exportMagneticPng').addEventListener('click', () => {
  downloadCanvasPng(sketch.getCanvas(), 'flow-field.png');
});

document.getElementById('exportDirectionalSvg').addEventListener('click', () => {
  exportDirectionalSVG(getDirectionalParams(), directionalSketch.getSources(), showSources);
});

document.getElementById('exportDirectionalPng').addEventListener('click', () => {
  downloadCanvasPng(directionalSketch.getCanvas(), 'flow-field-directional.png');
});

document.getElementById('chaosBtn').addEventListener('click', () => {
  sketch.toggleChaos();
  document.getElementById('chaosBtn').classList.toggle('active', sketch.getChaosMode());
});

document.getElementById('toggleSources').addEventListener('click', () => {
  showSources = !showSources;
  const btn = document.getElementById('toggleSources');
  btn.textContent = showSources ? 'On' : 'Off';
  btn.classList.toggle('active', showSources);
  sketch.redraw();
  directionalSketch.redraw();
});

document.getElementById('clear').addEventListener('click', () => {
  getActiveSketch().clearSources();
});

document.getElementById('undoBtn').addEventListener('click', () => getActiveSketch().undo());
document.getElementById('redoBtn').addEventListener('click', () => getActiveSketch().redo());

// ── Undo / Redo keyboard shortcuts ────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.metaKey && !e.shiftKey && e.key === 'z') {
    e.preventDefault();
    getActiveSketch().undo();
  }
  if ((e.metaKey && e.shiftKey && e.key === 'z') || (e.metaKey && e.key === 'y')) {
    e.preventDefault();
    getActiveSketch().redo();
  }
});
