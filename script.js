pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// 1 mm = 72/25.4 pt — everything in the final output is computed in PDF points
// so PDF sources can be re-embedded as vectors with zero rasterization loss.
const PT_PER_MM = 72 / 25.4;
function mmToPt(mm){ return mm * PT_PER_MM; }

const state = {
  size: 'A4',
  orientation: 'portrait',
  pagesWide: 2,
  overlapMm: 0,
  showLabels: true,

  type: null,           // 'pdf' | 'image'
  sourceName: '',

  // Common: aspect-defining dimensions. For PDFs these are true PDF points
  // (from a scale=1 viewport). For images these are native pixel counts.
  // Only their ratio + use as a consistent unit in computeLayout() matters.
  sourceWidthPt: null,
  sourceHeightPt: null,

  // PDF-specific
  pdfDoc: null,          // pdf.js document, for preview/page picking
  pdfBytes: null,         // original bytes, kept for pdf-lib embedding
  pdfPageIndex: 0,        // 0-based, for pdf-lib embedPdf

  // Image-specific
  imageBytes: null,
  imageFormat: null,      // 'png' | 'jpg'

  // Preview-only raster (canvas or <img>), never used for the export
  previewSource: null,
};

// ---------- element refs ----------
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileChip = document.getElementById('fileChip');
const pdfPageRow = document.getElementById('pdfPageRow');
const pdfPageSelect = document.getElementById('pdfPageSelect');
const sizeSeg = document.getElementById('sizeSeg');
const orientSeg = document.getElementById('orientSeg');
const pagesWideInput = document.getElementById('pagesWide');
const overlapSelect = document.getElementById('overlapMm');
const labelSeg = document.getElementById('labelSeg');
const generateBtn = document.getElementById('generateBtn');
const proofEmpty = document.getElementById('proofEmpty');
const proofStageWrap = document.getElementById('proofStageWrap');
const proofCanvas = document.getElementById('proofCanvas');
const proofLegend = document.getElementById('proofLegend');
const resultRow = document.getElementById('resultRow');
const resultText = document.getElementById('resultText');
const downloadBtn = document.getElementById('downloadBtn');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');

const mSize = document.getElementById('mSize');
const mGrid = document.getElementById('mGrid');
const mScale = document.getElementById('mScale');
const mFinished = document.getElementById('mFinished');
const mSheets = document.getElementById('mSheets');

let generatedPdfBlobUrl = null;
let generatedPdfName = 'tilepress-output.pdf';

// ---------- helpers ----------
function pageMM(size, orientation){
  let w, h;
  if (size === 'A4') { w = 210; h = 297; } else { w = 297; h = 420; }
  if (orientation === 'landscape') { const t = w; w = h; h = t; }
  return { w, h };
}

// All geometry here is in PDF points, so it maps 1:1 onto the final
// pdf-lib output — the preview just scales these numbers down for display.
function computeLayout(){
  if (!state.sourceWidthPt) return null;
  const mm = pageMM(state.size, state.orientation);
  const pagePtW = mmToPt(mm.w);
  const pagePtH = mmToPt(mm.h);
  const overlapPt = mmToPt(state.overlapMm);
  const advW = Math.max(1, pagePtW - overlapPt);
  const advH = Math.max(1, pagePtH - overlapPt);
  const pagesWide = Math.max(1, state.pagesWide);

  const scaledWidth = advW * (pagesWide - 1) + pagePtW;
  const scale = scaledWidth / state.sourceWidthPt;
  const scaledHeight = state.sourceHeightPt * scale;

  const pagesTall = scaledHeight <= pagePtH
    ? 1
    : 1 + Math.ceil((scaledHeight - pagePtH) / advH);

  const finishedWmm = scaledWidth / PT_PER_MM;
  const finishedHmm = (advH * (pagesTall - 1) + pagePtH) / PT_PER_MM;

  return { mm, pagePtW, pagePtH, overlapPt, advW, advH, pagesWide, pagesTall, scale, scaledWidth, scaledHeight, finishedWmm, finishedHmm };
}

function rowLabel(r){
  // A, B, C ... Z, AA, AB ...
  let s = '';
  r += 1;
  while (r > 0){
    const rem = (r - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    r = Math.floor((r - 1) / 26);
  }
  return s;
}

function updateTitleblock(layout){
  mSize.textContent = state.size + ' · ' + (state.orientation === 'portrait' ? 'Portrait' : 'Landscape');
  if (!layout){
    mGrid.textContent = '—'; mScale.textContent = '—'; mFinished.textContent = '—'; mSheets.textContent = '—';
    return;
  }
  mGrid.textContent = layout.pagesWide + ' × ' + layout.pagesTall;
  mScale.textContent = (layout.scale * 100).toFixed(0) + '%';
  mFinished.textContent = Math.round(layout.finishedWmm) + ' × ' + Math.round(layout.finishedHmm) + ' mm';
  mSheets.textContent = (layout.pagesWide * layout.pagesTall) + '';
}

function redrawProof(){
  const layout = computeLayout();
  updateTitleblock(layout);
  if (!layout || !state.previewSource){
    proofEmpty.style.display = 'block';
    proofStageWrap.style.display = 'none';
    proofLegend.style.display = 'none';
    generateBtn.disabled = true;
    return;
  }
  proofEmpty.style.display = 'none';
  proofStageWrap.style.display = 'flex';
  proofLegend.style.display = 'flex';
  generateBtn.disabled = false;

  // Preview canvas is sized to fit on screen, proportional to the full tiled
  // grid. It only stretches the low-res previewSource for display — the
  // real export never touches this canvas.
  const gridPtW = layout.advW * (layout.pagesWide - 1) + layout.pagePtW;
  const gridPtH = layout.advH * (layout.pagesTall - 1) + layout.pagePtH;
  const maxPreviewW = 620;
  const previewScale = Math.min(1, maxPreviewW / gridPtW);
  const cw = Math.max(1, Math.round(gridPtW * previewScale));
  const ch = Math.max(1, Math.round(gridPtH * previewScale));

  proofCanvas.width = cw;
  proofCanvas.height = ch;
  const ctx = proofCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);

  const imgW = layout.scaledWidth * previewScale;
  const imgH = layout.scaledHeight * previewScale;
  ctx.drawImage(state.previewSource, 0, 0, imgW, imgH);

  // grid lines, labels, overlap shading
  const pagePreviewW = layout.pagePtW * previewScale;
  const pagePreviewH = layout.pagePtH * previewScale;
  const advPreviewW = layout.advW * previewScale;
  const advPreviewH = layout.advH * previewScale;
  const overlapPreview = layout.overlapPt * previewScale;

  ctx.save();
  ctx.font = '600 10px "IBM Plex Mono", monospace';
  for (let r = 0; r < layout.pagesTall; r++){
    for (let c = 0; c < layout.pagesWide; c++){
      const x = c * advPreviewW;
      const y = r * advPreviewH;

      if (overlapPreview > 0){
        ctx.fillStyle = 'rgba(193,68,14,0.22)';
        if (c > 0) ctx.fillRect(x, y, overlapPreview, pagePreviewH);
        if (r > 0) ctx.fillRect(x, y, pagePreviewW, overlapPreview);
      }

      ctx.strokeStyle = 'rgba(22,35,59,0.75)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, pagePreviewW, pagePreviewH);

      ctx.setLineDash([]);
      if (state.showLabels){
        const label = rowLabel(r) + (c + 1);
        ctx.fillStyle = '#16233B';
        ctx.fillRect(x + 4, y + 4, label.length * 6.5 + 8, 14);
        ctx.fillStyle = '#EEF1EC';
        ctx.fillText(label, x + 8, y + 14);
      }
    }
  }
  ctx.restore();
}

// ---------- file handling ----------
function setFileChip(name){
  fileChip.innerHTML = `<div class="file-chip"><span>${name}</span><button id="clearFile" type="button">remove</button></div>`;
  document.getElementById('clearFile').addEventListener('click', () => {
    state.type = null;
    state.sourceWidthPt = null;
    state.sourceHeightPt = null;
    state.previewSource = null;
    state.pdfDoc = null;
    state.pdfBytes = null;
    state.imageBytes = null;
    fileChip.innerHTML = '';
    pdfPageRow.style.display = 'none';
    fileInput.value = '';
    redrawProof();
  });
}

async function loadImageFile(file){
  const bytes = new Uint8Array(await file.arrayBuffer());
  state.type = 'image';
  state.imageBytes = bytes;
  state.imageFormat = /png/i.test(file.type) || /\.png$/i.test(file.name) ? 'png' : 'jpg';
  state.sourceName = file.name.replace(/\.[^.]+$/, '');

  const blob = new Blob([bytes], { type: state.imageFormat === 'png' ? 'image/png' : 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  URL.revokeObjectURL(url);

  // Native pixel dimensions — used only as a consistent ratio unit in
  // computeLayout(). The image itself is embedded at full resolution
  // (no rasterization step) when the PDF is generated.
  state.sourceWidthPt = img.naturalWidth;
  state.sourceHeightPt = img.naturalHeight;
  state.previewSource = img;

  pdfPageRow.style.display = 'none';
  redrawProof();
}

async function loadPdfFile(file){
  const bytes = new Uint8Array(await file.arrayBuffer());
  state.type = 'pdf';
  state.pdfBytes = bytes;
  state.sourceName = file.name.replace(/\.[^.]+$/, '');

  // Separate copy handed to pdf.js — pdf.js may transfer/detach buffers
  // it's given, so state.pdfBytes (kept for pdf-lib embedding later)
  // must stay untouched.
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  state.pdfDoc = doc;

  pdfPageSelect.innerHTML = '';
  for (let i = 1; i <= doc.numPages; i++){
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = 'Page ' + i + ' of ' + doc.numPages;
    pdfPageSelect.appendChild(opt);
  }
  pdfPageRow.style.display = doc.numPages > 1 ? 'flex' : 'none';
  await loadPdfPageMeta(1);
}

async function loadPdfPageMeta(pageNum){
  const page = await state.pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 }); // scale=1 viewport is in true PDF points

  state.pdfPageIndex = pageNum - 1;
  state.sourceWidthPt = viewport.width;
  state.sourceHeightPt = viewport.height;

  // Low-res raster purely for the on-screen proof sheet — the real export
  // re-embeds this PDF page as a vector object, never this canvas.
  const previewTargetW = 700;
  const pvScale = previewTargetW / viewport.width;
  const pvViewport = page.getViewport({ scale: pvScale });
  const c = document.createElement('canvas');
  c.width = Math.ceil(pvViewport.width);
  c.height = Math.ceil(pvViewport.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: pvViewport }).promise;
  state.previewSource = c;

  redrawProof();
}

pdfPageSelect.addEventListener('change', () => loadPdfPageMeta(parseInt(pdfPageSelect.value, 10)));

async function handleFile(file){
  if (!file) return;
  const type = file.type;
  const nameLower = file.name.toLowerCase();
  setFileChip(file.name);
  if (type === 'application/pdf' || nameLower.endsWith('.pdf')){
    await loadPdfFile(file);
  } else if (type.startsWith('image/') || /\.(jpe?g|png)$/i.test(nameLower)){
    await loadImageFile(file);
  } else {
    alert('Please upload a JPG, PNG or PDF file.');
  }
}

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
['dragenter','dragover'].forEach(evt => dropzone.addEventListener(evt, (e) => {
  e.preventDefault(); dropzone.classList.add('drag');
}));
['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, (e) => {
  e.preventDefault(); dropzone.classList.remove('drag');
}));
dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

// ---------- controls ----------
function bindSeg(seg, onPick){
  seg.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onPick(btn.dataset.val);
    });
  });
}
bindSeg(sizeSeg, (v) => { state.size = v; redrawProof(); });
bindSeg(orientSeg, (v) => { state.orientation = v; redrawProof(); });
bindSeg(labelSeg, (v) => { state.showLabels = (v === 'show'); redrawProof(); });

function clampPagesWide(v){
  v = parseInt(v, 10);
  if (isNaN(v)) v = 1;
  return Math.min(30, Math.max(1, v));
}
pagesWideInput.addEventListener('change', () => {
  state.pagesWide = clampPagesWide(pagesWideInput.value);
  pagesWideInput.value = state.pagesWide;
  redrawProof();
});
document.getElementById('wMinus').addEventListener('click', () => {
  state.pagesWide = clampPagesWide(state.pagesWide - 1);
  pagesWideInput.value = state.pagesWide;
  redrawProof();
});
document.getElementById('wPlus').addEventListener('click', () => {
  state.pagesWide = clampPagesWide(state.pagesWide + 1);
  pagesWideInput.value = state.pagesWide;
  redrawProof();
});
overlapSelect.addEventListener('change', () => {
  state.overlapMm = parseFloat(overlapSelect.value);
  redrawProof();
});

// ---------- PDF generation (pdf-lib — vector-preserving) ----------
// PDF sources are re-embedded as a single shared vector XObject and placed
// on each output page with a plain translation; a page's MediaBox clips
// anything outside it automatically, so no rasterization or manual
// clip-path is needed. Image sources are embedded once at full native
// resolution (no downsampling) and reused across every tile the same way.
async function generatePdf(){
  const layout = computeLayout();
  if (!layout || !state.type) return;

  generateBtn.disabled = true;
  progressWrap.classList.add('show');
  resultRow.style.display = 'none';

  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Courier);
  const ink = rgb(0.086, 0.137, 0.231);
  const paperBg = rgb(0.933, 0.945, 0.925);

  let embeddedPage = null;
  let embeddedImage = null;
  let drawWidth, drawHeight;

  if (state.type === 'pdf'){
    [embeddedPage] = await outDoc.embedPdf(state.pdfBytes, [state.pdfPageIndex]);
    drawWidth = embeddedPage.width;
    drawHeight = embeddedPage.height;
  } else {
    embeddedImage = state.imageFormat === 'png'
      ? await outDoc.embedPng(state.imageBytes)
      : await outDoc.embedJpg(state.imageBytes);
    drawWidth = embeddedImage.width;
    drawHeight = embeddedImage.height;
  }

  const totalPages = layout.pagesWide * layout.pagesTall;
  const tickLen = 8;
  let count = 0;

  for (let r = 0; r < layout.pagesTall; r++){
    for (let c = 0; c < layout.pagesWide; c++){
      const page = outDoc.addPage([layout.pagePtW, layout.pagePtH]);

      const left = c * layout.advW;
      const top = r * layout.advH;
      const x = -left;
      const y = layout.pagePtH - layout.scaledHeight + top;

      if (state.type === 'pdf'){
        page.drawPage(embeddedPage, { x, y, xScale: layout.scale, yScale: layout.scale });
      } else {
        page.drawImage(embeddedImage, { x, y, width: drawWidth * layout.scale, height: drawHeight * layout.scale });
      }

      // registration ticks at each corner
      [[0, layout.pagePtH], [layout.pagePtW, layout.pagePtH], [0, 0], [layout.pagePtW, 0]].forEach(([cx, cy]) => {
        const dx = cx === 0 ? 1 : -1;
        const dy = cy === 0 ? 1 : -1;
        page.drawLine({ start: { x: cx, y: cy }, end: { x: cx + dx * tickLen, y: cy }, thickness: 1, color: ink });
        page.drawLine({ start: { x: cx, y: cy }, end: { x: cx, y: cy + dy * tickLen }, thickness: 1, color: ink });
      });

      // corner label
      if (state.showLabels){
        const label = rowLabel(r) + (c + 1);
        const labelSize = 11;
        const labelW = font.widthOfTextAtSize(label, labelSize);
        page.drawRectangle({ x: 8, y: layout.pagePtH - 30, width: labelW + 14, height: 20, color: paperBg, opacity: 0.9 });
        page.drawText(label, { x: 14, y: layout.pagePtH - 24, size: labelSize, font, color: ink });
      }

      count++;
      progressBar.style.width = Math.round((count / totalPages) * 100) + '%';
      progressLabel.textContent = 'Placing sheet ' + count + ' / ' + totalPages;
      await new Promise(res => setTimeout(res, 0));
    }
  }

  const pdfBytes = await outDoc.save();
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  if (generatedPdfBlobUrl) URL.revokeObjectURL(generatedPdfBlobUrl);
  generatedPdfBlobUrl = URL.createObjectURL(blob);
  generatedPdfName = (state.sourceName || 'tilepress') + '-' + state.size + '-' + layout.pagesWide + 'x' + layout.pagesTall + '.pdf';

  progressWrap.classList.remove('show');
  generateBtn.disabled = false;
  resultRow.style.display = 'flex';
  const qualityNote = state.type === 'pdf' ? 'vector' : 'full-res image';
  resultText.textContent = totalPages + ' sheets · ' + state.size + ' ' + state.orientation + ' · ' + Math.round(layout.finishedWmm) + '×' + Math.round(layout.finishedHmm) + ' mm finished · ' + qualityNote;
}

downloadBtn.addEventListener('click', () => {
  if (!generatedPdfBlobUrl) return;
  const a = document.createElement('a');
  a.href = generatedPdfBlobUrl;
  a.download = generatedPdfName;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

generateBtn.addEventListener('click', generatePdf);

redrawProof();
