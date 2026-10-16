// ─────────────────────────────────────────────────────────────────────────────
//  src/routes/evaluations.js
//  All evaluation endpoints including the step 7b exceptional-situation ones:
//    PATCH  /evaluations/:id/reassign-supervisor   reassignEvaluationSupervisor
//    POST   /evaluations/:id/open-self-assessment  openSelfAssessmentFor
//    POST   /evaluations/:id/waive-self-assessment waiveSelfAssessment
//    POST   /evaluations/:id/goals-on-behalf       saveGoalsOnBehalf
//    POST   /evaluations/:id/waive-employee-sig    waiveEmployeeSignature
//  Plus the existing step 1-6 endpoints.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import PDFDocument from 'pdfkit';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth.js';
import { query, getClient } from '../db.js';
import { canReassign, canSign, departureWaivers } from '../lib/rules.js';

const router = Router();
const SELF_EDITABLE = ['draft', 'goals_set', 'self_assessment'];
const SIG_DATA_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const MAX_SIG_CHARS = 400_000;
const ALL_SLOTS = ['employee', 'supervisor', 'hr_officer'];

// ── helpers ──────────────────────────────────────────────────────────────────

function appendAudit(existingLog, actor, action, details = {}) {
  const entry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action,
    details,
  };
  return [...(existingLog ?? []), entry];
}

function mergeJsonValues(existingValue, incomingValue) {
  if (incomingValue === undefined) return existingValue;
  if (incomingValue === null || typeof incomingValue !== 'object') return incomingValue;
  if (Array.isArray(incomingValue)) return incomingValue;
  if (!existingValue || typeof existingValue !== 'object' || Array.isArray(existingValue)) {
    return incomingValue;
  }

  const merged = { ...existingValue };
  for (const [key, value] of Object.entries(incomingValue)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = mergeJsonValues(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function hasValue(v) {
  if (v == null) return false;
  if (typeof v === 'object') {
    if (Array.isArray(v)) return v.some(hasValue);
    return Object.values(v).some(hasValue);
  }
  return String(v).trim() !== '';
}

function validSignatureImage(img) {
  return typeof img === 'string' && img.length <= MAX_SIG_CHARS && SIG_DATA_URL.test(img);
}

async function checkPassword(userId, password) {
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  return bcrypt.compare(password, rows[0]?.password_hash ?? '');
}

async function resolveSignatureImage(userId, image) {
  if (image) return validSignatureImage(image) ? image : null;
  const { rows } = await query('SELECT signature_image FROM users WHERE id = $1', [userId]);
  return rows[0]?.signature_image ?? null;
}

async function saveAudit(id, log) {
  await query('UPDATE evaluations SET audit_log = $1, updated_at = now() WHERE id = $2', [JSON.stringify(log), id]);
}

async function getEvalOrFail(res, id, client) {
  const q = client ?? query;
  const { rows } = await (client
    ? client.query('SELECT * FROM evaluations WHERE id = $1', [id])
    : query('SELECT * FROM evaluations WHERE id = $1', [id]));
  if (!rows[0]) {
    res.status(404).json({ error: `Evaluation ${id} not found.` });
    return null;
  }
  return rows[0];
}

async function loadSignatures(evaluationId, client = null) {
  const result = client
    ? await client.query(
        'SELECT * FROM signatures WHERE evaluation_id = $1',
        [evaluationId]
      )
    : await query(
        'SELECT * FROM signatures WHERE evaluation_id = $1',
        [evaluationId]
      );

  const signatures = {
    employee: null,
    supervisor: null,
    hr_officer: null,
  };

  for (const signature of result.rows) {
    signatures[signature.slot] = signature;
  }

  return signatures;
}

// ── PDF design ───────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO = (() => {
  try { return fs.readFileSync(path.join(__dirname, '../assets/cpp-logo.png')); }
  catch { return null; }
})();

const C = { brand: '#9CC13B', ink: '#0F172A', muted: '#64748B', line: '#E2E8F0', band: '#F8FAFC' };
const X0 = 50;
const CW = 495;

const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric' })
  : '—';
const fmtDateTime = (d) => d
  ? new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—';
const r = (v) => (v === null || v === undefined || v === '' ? '–' : String(v));
const s1 = (n) => (typeof n === 'number' ? n.toFixed(1) : '–');

// Score formula: average rating (1-5) / 5 x part weight. Weights: B 10, C 55, D 10, E 25.
const avg = (vals) => {
  const v = vals.filter((x) => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const part = (vals, weight) => { const a = avg(vals); return a === null ? null : (a / 5) * weight; };
function computeScores(ev, key) {
  const pick = (grp) => Object.values(ev.scores?.[grp] ?? {}).map((x) => x?.[key]);
  const B = part(pick('B'), 10);
  const Cc = part((ev.goals ?? []).map((g) => g?.[key]), 55);
  const D = part(pick('D'), 10);
  const E = part(pick('E'), 25);
  const total = [B, Cc, D, E].some((x) => x === null) ? null : B + Cc + D + E;
  return { B, C: Cc, D, E, total };
}

const CRITERIA = {
  B: [['meetingAttendanceRate', 'Meeting attendance rate'], ['punctuality', 'Punctuality'],
      ['participation', 'Active participation'], ['advanceNotice', 'Advance notice of absence']],
  D: [['timeManagement', 'Time management & deadline discipline']],
  E: [['communication', 'Communication & honesty'], ['ownership', 'Ownership & accountability'],
      ['quality', 'Quality & attention to detail'], ['teamwork', 'Teamwork & collaboration'],
      ['clientFocus', 'Client & service focus']],
};

function drawHeader(doc, subtitle) {
  const top = 36;
  let logoDrawn = false;
  if (LOGO) {
    try { doc.image(LOGO, X0, top, { fit: [130, 42] }); logoDrawn = true; } catch { /* fall back to text */ }
  }
  if (!logoDrawn) {
    doc.font('Helvetica-Bold').fontSize(15).fillColor(C.ink).text('CPP GROUP', X0, top + 12, { lineBreak: false });
  }
  doc.font('Helvetica').fontSize(8.5).fillColor(C.muted)
    .text(subtitle, 300, top + 16, { width: 245, align: 'right', lineBreak: false });
  doc.moveTo(X0, top + 52).lineTo(X0 + CW, top + 52).lineWidth(2).strokeColor(C.brand).stroke();
  doc.x = X0;
  doc.y = top + 68;
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - 70) doc.addPage(); // header is redrawn by the pageAdded hook
}

function sectionTitle(doc, text) {
  ensureSpace(doc, 70);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink)
    .text(text.toUpperCase(), X0, doc.y, { characterSpacing: 0.6 });
  const y = doc.y + 3;
  doc.moveTo(X0, y).lineTo(X0 + CW, y).lineWidth(0.75).strokeColor(C.line).stroke();
  doc.x = X0;
  doc.y = y + 10;
}

function infoGrid(doc, items) {
  const top = doc.y + 4;
  const h = 58;
  doc.roundedRect(X0, top, CW, h, 6).fillAndStroke(C.band, C.line);
  const colW = CW / items.length;
  items.forEach(([label, value], i) => {
    const x = X0 + i * colW + 14;
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(7.5)
      .text(label.toUpperCase(), x, top + 14, { width: colW - 20, lineBreak: false });
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(12)
      .text(String(value ?? '—'), x, top + 29, { width: colW - 20, lineBreak: false });
  });
  doc.x = X0;
  doc.y = top + h + 18;
}

function cellHeight(doc, cell, w, bold) {
  if (cell && typeof cell === 'object') {
    doc.font('Helvetica-Bold').fontSize(9.5);
    let h = doc.heightOfString(String(cell.title ?? ''), { width: w });
    if (cell.sub) {
      doc.font('Helvetica').fontSize(8.5);
      h += 2 + doc.heightOfString(String(cell.sub), { width: w });
    }
    return h;
  }
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
  return doc.heightOfString(String(cell ?? ''), { width: w });
}

function drawCell(doc, cell, x, y, w, { bold, color, align }) {
  if (cell && typeof cell === 'object') {
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(String(cell.title ?? ''), x, y, { width: w });
    if (cell.sub) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(String(cell.sub), x, doc.y + 2, { width: w });
    }
    return;
  }
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(color)
    .text(String(cell ?? ''), x, y, { width: w, align });
}

function table(doc, cols, rows) {
  const pad = 7;
  const out = (cells, { header = false, strong = false, zebra = false } = {}) => {
    const bold = header || strong;
    const h = Math.max(...cells.map((c, i) => cellHeight(doc, c, cols[i].width - pad * 2, bold))) + pad * 2;
    ensureSpace(doc, h + 4);
    const y = doc.y;
    if (header) doc.rect(X0, y, CW, h).fill(C.ink);
    else if (strong) doc.rect(X0, y, CW, h).fill('#ECF3D6');
    else if (zebra) doc.rect(X0, y, CW, h).fill(C.band);
    let x = X0;
    cells.forEach((c, i) => {
      drawCell(doc, c, x + pad, y + pad, cols[i].width - pad * 2, {
        bold, color: header ? '#FFFFFF' : C.ink, align: cols[i].align || 'left',
      });
      x += cols[i].width;
    });
    doc.moveTo(X0, y + h).lineTo(X0 + CW, y + h).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.x = X0;
    doc.y = y + h;
  };

  out(cols.map((c) => c.label), { header: true });
  rows.forEach((row, i) => {
    if (row.group) {
      const h = 22;
      ensureSpace(doc, h + 30);
      const y = doc.y;
      doc.rect(X0, y, CW, h).fill('#EEF2F7');
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text(row.group, X0 + pad, y + 6, { width: CW - pad * 2, lineBreak: false });
      doc.x = X0;
      doc.y = y + h;
    } else {
      out(row.cells, { strong: !!row.strong, zebra: i % 2 === 1 });
    }
  });
  doc.moveDown(1);
}

function textBlock(doc, label, value) {
  const text = String(value ?? '').trim() || 'None recorded';
  doc.font('Helvetica').fontSize(10);
  const vh = doc.heightOfString(text, { width: CW });
  ensureSpace(doc, vh + 30);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C.muted)
    .text(label.toUpperCase(), X0, doc.y, { width: CW, characterSpacing: 0.5 });
  doc.font('Helvetica').fontSize(10).fillColor(C.ink).text(text, X0, doc.y + 3, { width: CW });
  doc.x = X0;
  doc.moveDown(0.8);
}

function signatureBoxes(doc, sigs) {
  const slots = [['employee', 'Employee'], ['supervisor', 'Supervisor'], ['hr_officer', 'HR Officer']];
  const w = 155, gap = 15, h = 130;
  ensureSpace(doc, h + 40);
  const top = doc.y;
  slots.forEach(([slot, label], i) => {
    const x = X0 + i * (w + gap);
    const sig = sigs[slot];
    doc.roundedRect(x, top, w, h, 6).lineWidth(0.75).strokeColor(C.line).stroke();
    doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8)
      .text(label.toUpperCase(), x + 10, top + 10, { width: w - 20, lineBreak: false, characterSpacing: 0.5 });

    if (!sig) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(C.muted).text('Not signed', x + 10, top + 50, { width: w - 20 });
      return;
    }
    if (sig.type === 'waived') {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(C.muted)
        .text(`Waived: ${sig.note ?? ''}`, x + 10, top + 30, { width: w - 20, height: 40 });
    } else if (sig.image) {
      try {
        doc.image(Buffer.from(sig.image.split(',')[1], 'base64'), x + 10, top + 26, { fit: [w - 20, 48], align: 'left' });
      } catch {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor(C.muted).text('[signature could not be rendered]', x + 10, top + 40, { width: w - 20 });
      }
    }
    doc.moveTo(x + 10, top + 80).lineTo(x + w - 10, top + 80).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink)
      .text(String(sig.signer_name ?? ''), x + 10, top + 86, { width: w - 20, lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(C.muted)
      .text(fmtDateTime(sig.signed_at), x + 10, top + 100, { width: w - 20, lineBreak: false });
    if (sig.type === 'captured') {
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(C.muted)
        .text('Captured in person', x + 10, top + 112, { width: w - 20, lineBreak: false });
    }
  });
  doc.x = X0;
  doc.y = top + h + 12;
  doc.font('Helvetica').fontSize(8).fillColor(C.muted)
    .text("Each signature was confirmed with the signer's password at the time of signing.", X0, doc.y, { width: CW });
}

function drawEvaluationPdf(doc, { ev, sigs, nameOf }) {
  const staff = computeScores(ev, 'staff');
  const sup = computeScores(ev, 'supervisor');
  const agreed = computeScores(ev, 'agreed');

  doc.font('Helvetica-Bold').fontSize(20).fillColor(C.ink).text('Staff Performance Evaluation', X0, doc.y);
  doc.font('Helvetica').fontSize(10).fillColor(C.muted).text(`Performance review · ${ev.period}`);
  doc.moveDown(0.8);

  infoGrid(doc, [
    ['Employee', nameOf(ev.employee_id)],
    ['Supervisor', nameOf(ev.supervisor_id)],
    ['Period', ev.period],
    ['Overall score', agreed.total === null ? '–' : `${agreed.total.toFixed(1)} / 100`],
  ]);

  sectionTitle(doc, 'Score summary');
  table(doc,
    [{ label: 'PART', width: 195 }, { label: 'WEIGHT', width: 60, align: 'center' },
     { label: 'STAFF', width: 80, align: 'center' }, { label: 'SUPERVISOR', width: 80, align: 'center' },
     { label: 'AGREED', width: 80, align: 'center' }],
    [
      { cells: ['B — Attendance & Participation', '10%', s1(staff.B), s1(sup.B), s1(agreed.B)] },
      { cells: ['C — Outcomes & Results', '55%', s1(staff.C), s1(sup.C), s1(agreed.C)] },
      { cells: ['D — Time Management', '10%', s1(staff.D), s1(sup.D), s1(agreed.D)] },
      { cells: ['E — Professional Behaviours', '25%', s1(staff.E), s1(sup.E), s1(agreed.E)] },
      { strong: true, cells: ['Total', '100%', s1(staff.total), s1(sup.total), s1(agreed.total)] },
    ]);

  const crit = (grp) => CRITERIA[grp].map(([k, label]) => {
    const x = ev.scores?.[grp]?.[k] ?? {};
    return { cells: [{ title: label, sub: x.evidence ? `Staff evidence: ${x.evidence}` : '' }, r(x.staff), r(x.supervisor), r(x.agreed)] };
  });
  const goalRows = (ev.goals ?? []).map((g, i) => ({
    cells: [
      { title: `Goal ${i + 1}: ${g.outcome ?? ''}`,
        sub: [g.measure && `Measure: ${g.measure}`, g.achieved && `Achieved: ${g.achieved}`].filter(Boolean).join('\n') },
      r(g.staff), r(g.supervisor), r(g.agreed),
    ],
  }));

  sectionTitle(doc, 'Detailed ratings (1 to 5)');
  table(doc,
    [{ label: 'CRITERION', width: 255 }, { label: 'STAFF', width: 80, align: 'center' },
     { label: 'SUPERVISOR', width: 80, align: 'center' }, { label: 'AGREED', width: 80, align: 'center' }],
    [
      { group: 'Part B — Attendance & Participation' }, ...crit('B'),
      { group: 'Part C — Outcomes & Results' }, ...goalRows,
      { group: 'Part D — Time Management' }, ...crit('D'),
      { group: 'Part E — Professional Behaviours' }, ...crit('E'),
    ]);

  const labels = { B: 'Attendance & Participation', C: 'Outcomes & Results', D: 'Time Management', E: 'Professional Behaviours' };
  const commentRows = ['B', 'C', 'D', 'E']
    .map((k) => ({ k, c: ev.comments?.[k] ?? {} }))
    .filter(({ c }) => String(c.staff ?? '').trim() || String(c.supervisor ?? '').trim())
    .map(({ k, c }) => ({ cells: [{ title: `${k} — ${labels[k]}` }, String(c.staff ?? '').trim() || '–', String(c.supervisor ?? '').trim() || '–'] }));
  if (commentRows.length) {
    sectionTitle(doc, 'Comments');
    table(doc,
      [{ label: 'PART', width: 165 }, { label: 'STAFF', width: 165 }, { label: 'SUPERVISOR', width: 165 }],
      commentRows);
  }

  sectionTitle(doc, 'Part H — Growth & Development');
  textBlock(doc, 'Key strengths', ev.part_h?.strengths);
  textBlock(doc, 'Development areas', ev.part_h?.developmentAreas);
  textBlock(doc, 'Agreed actions & support required', ev.part_h?.agreedActions);
  if (ev.part_h?.reviewDate) textBlock(doc, 'Follow-up review date', fmtDate(ev.part_h.reviewDate));

  sectionTitle(doc, 'Review meeting');
  textBlock(doc, 'Meeting date', ev.review_meeting?.date ? fmtDate(ev.review_meeting.date) : '');
  textBlock(doc, 'Discussion notes', ev.review_meeting?.notes);

  sectionTitle(doc, 'Part I — Executive Leader Comments');
  textBlock(doc, 'Leader comment', ev.part_i?.comment);
  if (ev.part_i?.authorName) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(C.muted)
      .text(`— ${ev.part_i.authorName}, ${fmtDate(ev.part_i.submittedAt)}`, X0, doc.y - 4);
    doc.moveDown(0.8);
  }

  sectionTitle(doc, 'Part J — Digital Sign-off & Confirmation');
  signatureBoxes(doc, sigs);
}

function addFooters(doc, evaluationId) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor(C.muted)
      .text(`CPP Group · Confidential · ${evaluationId}`, X0, doc.page.height - 40, { width: 350, lineBreak: false })
      .text(`Page ${i + 1} of ${range.count}`, 400, doc.page.height - 40, { width: 145, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

function buildPdfBuffer(data) {
  return new Promise((resolve, reject) => {
    const subtitle = `${data.nameOf(data.ev.employee_id)} · ${data.ev.period}`;
    const doc = new PDFDocument({
      margin: 50, size: 'A4', bufferPages: true,
      info: { Title: `Staff Performance Evaluation - ${subtitle}`, Author: 'CPP Group' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      doc.on('pageAdded', () => drawHeader(doc, subtitle));
      drawHeader(doc, subtitle);
      drawEvaluationPdf(doc, data);
      addFooters(doc, data.ev.id);
      doc.end();
    } catch (e) { reject(e); }
  });
}

// ── GET /evaluations/mine ─────────────────────────────────────────────────
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    let { rows } = await query(
      `SELECT e.*, eu.name AS employee_name, u.name AS supervisor_name
       FROM evaluations e
       LEFT JOIN users eu ON eu.id = e.employee_id
       LEFT JOIN users u ON u.id = e.supervisor_id
       WHERE e.employee_id = $1
       ORDER BY e.updated_at DESC`,
      [req.user.id]
    );

    if (!rows[0]) {
      // Auto-heal: if an open cycle exists, create evaluation stub
      const { rows: cycles } = await query(
        `SELECT * FROM cycles WHERE status != 'locked' ORDER BY opened_at DESC LIMIT 1`
      );
      if (cycles[0]) {
        const cycle = cycles[0];
        const evalId = `ev-${cycle.period.trim().replace(/\s+/g, '-').toLowerCase()}-${req.user.id}`;
        const { rows: uRows } = await query('SELECT supervisor_id FROM users WHERE id = $1', [req.user.id]);
        const supId = uRows[0]?.supervisor_id || null;

        await query(
          `INSERT INTO evaluations
             (id, employee_id, supervisor_id, period, status, attendance, goals, scores,
              comments, part_h, review_meeting)
           VALUES ($1,$2,$3,$4,'draft','[]','[]','{}','{}','{}','{}')
           ON CONFLICT (id) DO NOTHING`,
          [evalId, req.user.id, supId, cycle.period.trim()]
        );

        const { rows: created } = await query(
          `SELECT e.*, eu.name AS employee_name, u.name AS supervisor_name
           FROM evaluations e
           LEFT JOIN users eu ON eu.id = e.employee_id
           LEFT JOIN users u ON u.id = e.supervisor_id
           WHERE e.id = $1`,
          [evalId]
        );
        rows = created;
      }
    }

    // Frontends commonly treat this as a list endpoint; an empty list is a valid state.
    res.json(rows ?? []);
  } catch (err) {
    next(err);
  }
});

// ── GET /evaluations  (team / admin) ────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    let rows;
    if (req.user.role === 'admin') {
      ({ rows } = await query(
        `SELECT e.*, eu.name AS employee_name, su.name AS supervisor_name
         FROM evaluations e
         LEFT JOIN users eu ON eu.id = e.employee_id
         LEFT JOIN users su ON su.id = e.supervisor_id
         ORDER BY e.updated_at DESC`
      ));
    } else {
      // Auto-sync: keep open evaluations supervisor_id aligned with current users.supervisor_id
      await query(
        `UPDATE evaluations e
         SET supervisor_id = u.supervisor_id
         FROM users u
         WHERE e.employee_id = u.id
           AND u.supervisor_id = $1
           AND (e.supervisor_id IS DISTINCT FROM $1)
           AND e.status != 'locked'`,
        [req.user.id]
      );

      ({ rows } = await query(
        `SELECT e.*, eu.name AS employee_name, su.name AS supervisor_name
         FROM evaluations e
         LEFT JOIN users eu ON eu.id = e.employee_id
         LEFT JOIN users su ON su.id = e.supervisor_id
         WHERE e.supervisor_id = $1 OR e.employee_id = $1
         ORDER BY e.updated_at DESC`,
        [req.user.id]
      ));
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /evaluations/signature/me ────────────────────────────────────────
router.get('/signature/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT signature_image FROM users WHERE id = $1', [req.user.id]);
    res.json({ signature: rows[0]?.signature_image ?? null });
  } catch (err) {
    next(err);
  }
});

// ── PUT /evaluations/signature/me ────────────────────────────────────────
router.put('/signature/me', requireAuth, async (req, res, next) => {
  try {
    const { image } = req.body ?? {};
    if (!validSignatureImage(image)) {
      return res.status(400).json({ error: 'Provide a PNG or JPEG data URL under 300KB.' });
    }
    await query('UPDATE users SET signature_image = $1 WHERE id = $2', [image, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/attach-signature ───────────────────────────────
router.post('/:id/attach-signature', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { slot, password, image } = req.body ?? {};
    if (!['employee', 'supervisor'].includes(slot) || !password) {
      return res.status(400).json({ error: 'slot (employee|supervisor) and password are required.' });
    }

    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.status !== 'review_meeting') {
      return res.status(422).json({ error: `Signatures can only be attached during review_meeting (current: ${ev.status}).` });
    }
    if (!ev.part_h_by) {
      return res.status(422).json({ error: 'Save the agreed scores before anyone signs.' });
    }

    const isSupervisor = ev.supervisor_id === req.user.id;
    const isEmployee = ev.employee_id === req.user.id;
    let type = 'signed';
    let img;

    if (slot === 'supervisor') {
      if (!isSupervisor) return res.status(403).json({ error: 'Only the assigned supervisor can sign this slot.' });
      img = await resolveSignatureImage(req.user.id, image);
    } else if (isEmployee) {
      img = await resolveSignatureImage(req.user.id, image);
    } else if (isSupervisor) {
      // supervisor captures the employee's signature in person: must be freshly drawn
      if (!validSignatureImage(image)) {
        return res.status(400).json({ error: "Draw the employee's signature on screen." });
      }
      img = image;
      type = 'captured';
    } else {
      return res.status(403).json({ error: 'You cannot sign this slot.' });
    }

    if (!img) return res.status(400).json({ error: 'No signature provided.' });
    if (!(await checkPassword(req.user.id, password))) {
      return res.status(401).json({ error: 'Password confirmation failed.' });
    }

    const sigs = await loadSignatures(id, null);
    if (sigs[slot]) return res.status(409).json({ error: `The ${slot} slot is already signed.` });

    // for 'captured', signer_* is the supervisor who entered it; the audit entry names the employee
    await query(
      `INSERT INTO signatures (evaluation_id, slot, signer_id, signer_name, signer_role, type, image, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, slot, req.user.id, req.user.name, req.user.role, type, img,
       type === 'captured' ? 'Captured in person by supervisor' : null]
    );

    await saveAudit(id, appendAudit(ev.audit_log, req.user, 'SIGNATURE_ATTACHED', { slot, type }));
    res.json({ evaluationId: id, signatures: await loadSignatures(id, null) });
  } catch (err) { next(err); }
});

router.post('/:id/signoff-signature', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { password, image } = req.body ?? {};
    if (!password) return res.status(400).json({ error: 'password is required.' });

    if (!['admin', 'hr_officer'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Only HR can sign the HR Officer slot.' });
    }

    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;
    if (ev.status !== 'signoff') {
      return res.status(422).json({ error: `Sign-off is not open (current: ${ev.status}).` });
    }
    if (!(await checkPassword(req.user.id, password))) {
      return res.status(401).json({ error: 'Password confirmation failed.' });
    }

    const sigs = await loadSignatures(id, null);
    if (!sigs.employee || !sigs.supervisor) {
      return res.status(422).json({ error: 'The employee and supervisor must sign first.' });
    }
    if (sigs.hr_officer) return res.status(409).json({ error: 'HR has already signed.' });

    const img = await resolveSignatureImage(req.user.id, image);
    if (!img) return res.status(400).json({ error: 'No signature provided.' });

    await query(
      `INSERT INTO signatures (evaluation_id, slot, signer_id, signer_name, signer_role, type, image)
       VALUES ($1,'hr_officer',$2,$3,$4,'signed',$5)`,
      [id, req.user.id, req.user.name, req.user.role, img]
    );

    const updatedSigs = await loadSignatures(id, null);
    const newStatus = ALL_SLOTS.every((s) => updatedSigs[s]) ? 'hr_review' : 'signoff';
    const newLog = appendAudit(ev.audit_log, req.user, 'HR_SIGNED', { newStatus });

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = $1, audit_log = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [newStatus, JSON.stringify(newLog), id]
    );
    res.json({ ...updated, signatures: updatedSigs });
  } catch (err) { next(err); }
});

// ── GET /evaluations/:id ──────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const ev = await getEvalOrFail(res, req.params.id, null);
    if (!ev) return;
    const canRead =
      req.user.role === 'admin' ||
      ev.employee_id === req.user.id ||
      ev.supervisor_id === req.user.id;
    if (!canRead) {
      return res.status(403).json({ error: 'Forbidden: you do not have permission to view this evaluation.' });
    }
    const sigs = await loadSignatures(ev.id, null);
    res.json({ ...ev, signatures: sigs });
  } catch (err) {
    next(err);
  }
});

// ── GET /evaluations/:id/self-assessment ──────────────────────────────────
router.get('/:id/self-assessment', requireAuth, async (req, res, next) => {
  try {
    const ev = await getEvalOrFail(res, req.params.id, null);
    if (!ev) return;

    const canRead =
      req.user.role === 'admin' ||
      ev.employee_id === req.user.id ||
      ev.supervisor_id === req.user.id;
    if (!canRead) {
      return res.status(403).json({ error: 'Forbidden: you do not have permission to view this self-assessment.' });
    }

    const { rows: names } = await query(
      'SELECT id, name FROM users WHERE id = ANY($1)',
      [[ev.employee_id, ev.supervisor_id].filter(Boolean)]
    );
    const nameOf = (uid) => names.find((u) => u.id === uid)?.name ?? null;

    const submission = [...(ev.audit_log ?? [])]
      .reverse()
      .find((entry) => entry.action === 'SELF_ASSESSMENT_SUBMITTED');

    res.json({
      evaluationId: ev.id,
      period: ev.period,
      status: ev.status,
      employee: { id: ev.employee_id, name: nameOf(ev.employee_id) },
      supervisor: { id: ev.supervisor_id, name: nameOf(ev.supervisor_id) },
      submitted: !SELF_EDITABLE.includes(ev.status),
      submittedAt: submission?.timestamp ?? null,
      waived: !!ev.waived_self_assessment_note,
      waivedNote: ev.waived_self_assessment_note ?? null,
      goals: ev.goals,
      attendance: ev.attendance,
      scores: ev.scores,
      comments: ev.comments,
      part_h: ev.part_h,
    });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/goals ──────────────────────────────────────────
router.patch('/:id/goals', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { goals } = req.body ?? {};
    if (!Array.isArray(goals)) {
      return res.status(400).json({ error: 'goals must be an array.' });
    }
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.employee_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: you can only edit your own goals.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET goals = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [JSON.stringify(goals), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/goals/submit ────────────────────────────────────
router.post('/:id/goals/submit', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.employee_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: you can only submit your own goals.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'goals_submitted', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/goals/approve ───────────────────────────────────
router.post('/:id/goals/approve', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.supervisor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: only the assigned supervisor may approve goals.' });
    }

    const { rows: cycleRows } = await query(`SELECT status FROM cycles WHERE period = $1`, [ev.period]);
    const nextStatus = cycleRows[0]?.status === 'self_assessment' ? 'self_assessment' : 'goals_set';

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = $1, goals_rejection_note = NULL, updated_at = now() WHERE id = $2 RETURNING *`,
      [nextStatus, id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/goals/reject ────────────────────────────────────
router.post('/:id/goals/reject', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.supervisor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: only the assigned supervisor may reject goals.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'draft', goals_rejection_note = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [note || 'Goals returned for revision', id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/self ───────────────────────────────────────────
router.patch('/:id/self', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { scores, comments, goals } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.employee_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    if (ev.employee_id === req.user.id && req.user.role !== 'admin' && !SELF_EDITABLE.includes(ev.status)) {
      return res.status(422).json({ error: 'Your self-assessment has been submitted and can no longer be edited.' });
    }

    const setClauses = [];
    const values = [];
    let idx = 1;
    if (scores !== undefined) {
      setClauses.push(`scores = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.scores ?? {}, scores)));
    }
    if (comments !== undefined) {
      setClauses.push(`comments = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.comments ?? {}, comments)));
    }
    if (Array.isArray(goals)) {
      const merged = (ev.goals ?? []).map((g) => {
        const inc = goals.find((x) => x.id === g.id);
        return inc ? { ...g, achieved: inc.achieved ?? g.achieved, staff: inc.staff ?? g.staff } : g;
      });
      setClauses.push(`goals = $${idx++}`);
      values.push(JSON.stringify(merged));
    }
    setClauses.push(`updated_at = now()`);
    values.push(id);

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/self/submit ─────────────────────────────────────
router.post('/:id/self/submit', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { scores, comments } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.employee_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    if (!SELF_EDITABLE.includes(ev.status)) {
      return res.status(422).json({
        error: `Self-assessment has already been submitted (current status: ${ev.status}).`,
      });
    }

    const { rows: uRows } = await query(
      'SELECT supervisor_id FROM users WHERE id = $1',
      [ev.employee_id]
    );
    const supervisorId = ev.supervisor_id || uRows[0]?.supervisor_id || null;
    if (!supervisorId) {
      return res.status(422).json({
        error: 'No supervisor is assigned to this employee. Ask an admin to assign one before submitting.',
      });
    }

    const finalScores = mergeJsonValues(ev.scores ?? {}, scores ?? {});
    const finalComments = mergeJsonValues(ev.comments ?? {}, comments ?? {});

    if (!hasValue(finalScores)) {
      return res.status(400).json({ error: 'Fill in your self-assessment scores before submitting.' });
    }

    const newLog = appendAudit(ev.audit_log, req.user, 'SELF_ASSESSMENT_SUBMITTED', {
      supervisorId,
    });

    const { rows: [updated] } = await query(
      `UPDATE evaluations
       SET status = 'supervisor_assessment',
           supervisor_id = $1,
           scores = $2,
           comments = $3,
           audit_log = $4,
           updated_at = now()
       WHERE id = $5 RETURNING *`,
      [
        supervisorId,
        JSON.stringify(finalScores),
        JSON.stringify(finalComments),
        JSON.stringify(newLog),
        id,
      ]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/supervisor ─────────────────────────────────────
router.patch('/:id/supervisor', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { scores, comments } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.supervisor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    const setClauses = [];
    const values = [];
    let idx = 1;
    if (scores !== undefined) {
      setClauses.push(`scores = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.scores ?? {}, scores)));
    }
    if (comments !== undefined) {
      setClauses.push(`comments = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.comments ?? {}, comments)));
    }
    setClauses.push(`supervisor_scored_by = $${idx++}`);
    values.push(req.user.id);
    setClauses.push(`updated_at = now()`);
    values.push(id);

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/supervisor/submit ───────────────────────────────
router.post('/:id/supervisor/submit', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.supervisor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'review_meeting', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/agreed ─────────────────────────────────────────
router.patch('/:id/agreed', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { scores, goals, partH, reviewMeeting } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.supervisor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    if (['executive_review', 'signoff', 'hr_review', 'locked'].includes(ev.status)) {
      return res.status(422).json({ error: 'Agreed scores can no longer be edited at this stage.' });
    }

    const existing = await loadSignatures(id, null);
    let auditLog = ev.audit_log;
    if (existing.employee || existing.supervisor) {
      await query(`DELETE FROM signatures WHERE evaluation_id = $1 AND slot IN ('employee','supervisor')`, [id]);
      auditLog = appendAudit(ev.audit_log, req.user, 'SIGNATURES_CLEARED_AFTER_EDIT', {});
    }

    const setClauses = [];
    const values = [];
    let idx = 1;
    if (scores !== undefined) {
      setClauses.push(`scores = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.scores ?? {}, scores)));
    }
    if (goals !== undefined) {
      setClauses.push(`goals = $${idx++}`);
      values.push(JSON.stringify(Array.isArray(goals) ? goals : mergeJsonValues(ev.goals ?? [], goals)));
    }
    if (partH !== undefined) {
      setClauses.push(`part_h = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.part_h ?? {}, partH)));
    }
    if (reviewMeeting !== undefined) {
      setClauses.push(`review_meeting = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.review_meeting ?? {}, reviewMeeting)));
    }
    setClauses.push(`part_h_by = $${idx++}`);
    values.push(req.user.id);
    setClauses.push(`audit_log = $${idx++}`);
    values.push(JSON.stringify(auditLog));
    setClauses.push(`updated_at = now()`);
    values.push(id);

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/agreed/confirm ──────────────────────────────────
router.post('/:id/agreed/confirm', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.supervisor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    if (ev.status !== 'review_meeting') {
      return res.status(422).json({ error: `Cannot submit from status ${ev.status}.` });
    }

    const sigs = await loadSignatures(id, null);
    if (!sigs.supervisor?.signed_at || !sigs.employee?.signed_at) {
      return res.status(422).json({ error: 'Both the supervisor and the employee must sign before submitting to the executive.' });
    }

    const newLog = appendAudit(ev.audit_log, req.user, 'SUBMITTED_TO_EXECUTIVE', {});
    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'executive_review', audit_log = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [JSON.stringify(newLog), id]
    );
    res.json({ ...updated, signatures: sigs });
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/executive/approve ───────────────────────────────
router.post('/:id/executive/approve', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { comment = '', noComment = false } = req.body ?? {};

    if (!['admin', 'executive'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: executive or admin only.' });
    }

    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.status !== 'executive_review') {
      return res.status(422).json({
        error: `Evaluation is not awaiting executive review (current: ${ev.status}).`,
      });
    }
    if (!noComment && !String(comment).trim()) {
      return res.status(400).json({
        error: 'A leader comment is required unless "No further comment" is ticked.',
      });
    }

    const partI = {
      authorId: req.user.id,
      authorName: req.user.name,
      comment: noComment ? 'No further comment' : String(comment).trim(),
      noComment: !!noComment,
      submittedAt: new Date().toISOString(),
    };
    const newLog = appendAudit(ev.audit_log, req.user, 'EXECUTIVE_APPROVED', { noComment: !!noComment });

    const { rows: [updated] } = await query(
      `UPDATE evaluations
       SET status = 'signoff', part_i = $1, audit_log = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [JSON.stringify(partI), JSON.stringify(newLog), id]
    );
    res.json(updated);
  } catch (err) { next(err); }
});

// ── POST /evaluations/:id/hr/approve ──────────────────────────────────────
router.post('/:id/hr/approve', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!['admin', 'hr_officer'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: HR or admin only.' });
    }

    const data = await loadEvalForPdf(id);
    if (!data) return res.status(404).json({ error: `Evaluation ${id} not found.` });
    const { ev, sigs } = data;

    if (ev.status !== 'hr_review') {
      return res.status(422).json({ error: `Evaluation must be in hr_review (current: ${ev.status}).` });
    }
    if (!ALL_SLOTS.every((s) => sigs[s])) {
      return res.status(422).json({ error: 'All three signatures are required before finalizing.' });
    }

    const pdf = await buildPdfBuffer(data);
    await query(
      `INSERT INTO evaluation_archives (evaluation_id, pdf, created_by)
       VALUES ($1,$2,$3) ON CONFLICT (evaluation_id) DO NOTHING`,
      [id, pdf, req.user.id]
    );

    const newLog = appendAudit(ev.audit_log, req.user, 'EVALUATION_FINALIZED', {});
    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'locked', audit_log = $1, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify(newLog), id]
    );
    res.json({ ...updated, signatures: sigs });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/attendance ─────────────────────────────────────
router.patch('/:id/attendance', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { attendance } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET attendance = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [JSON.stringify(attendance || []), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/incidents ──────────────────────────────────────
router.patch('/:id/incidents', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { incidents } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET incidents = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [JSON.stringify(incidents || []), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/staff-reply ─────────────────────────────────────
router.post('/:id/staff-reply', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { comment } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.employee_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden: only the employee may reply.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET staff_comment_on_agreed = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [comment || '', id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/reassign-supervisor  (reassignEvaluationSupervisor) ──
router.patch('/:id/reassign-supervisor', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { newSupervisorId, reason } = req.body ?? {};
    if (!newSupervisorId || !reason) {
      return res.status(400).json({ error: 'newSupervisorId and reason are required.' });
    }

    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    const { rows: newSupRows } = await query('SELECT * FROM users WHERE id = $1', [newSupervisorId]);
    const newSup = newSupRows[0];
    if (!newSup) return res.status(404).json({ error: `User ${newSupervisorId} not found.` });

    const sigs = await loadSignatures(id, null);
    const check = canReassign({ ...ev, signatures: sigs }, newSup);
    if (!check.allowed) {
      return res.status(422).json({ error: check.reason });
    }

    const oldSupId = ev.supervisor_id;
    const newLog = appendAudit(ev.audit_log, req.user, 'SUPERVISOR_REASSIGNED', {
      oldSupervisorId: oldSupId,
      newSupervisorId,
      reason,
    });

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET supervisor_id = $1, audit_log = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [newSupervisorId, JSON.stringify(newLog), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/open-self-assessment  (openSelfAssessmentFor) ──────
router.post('/:id/open-self-assessment', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (!['draft', 'goals_set'].includes(ev.status)) {
      return res.status(422).json({
        error: `Cannot open self-assessment from status ${ev.status}.`,
      });
    }

    const newLog = appendAudit(ev.audit_log, req.user, 'SELF_ASSESSMENT_OPENED_MANUALLY', {});
    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'self_assessment', audit_log = $1, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify(newLog), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/waive-self-assessment  (waiveSelfAssessment) ────────
router.post('/:id/waive-self-assessment', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note } = req.body ?? {};
    if (!note?.trim()) {
      return res.status(400).json({ error: 'note is required to waive self-assessment.' });
    }

    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.status !== 'self_assessment') {
      return res.status(422).json({
        error: `Can only waive self-assessment during self_assessment status (current: ${ev.status}).`,
      });
    }

    // App-layer departure check (DB trigger also enforces this)
    if (!ev.departure) {
      return res.status(422).json({
        error: 'Waiving self-assessment requires a departure record on the evaluation.',
      });
    }

    // Departure waivers check
    const waivers = departureWaivers(ev);
    if (!waivers.canWaiveSelfAssessment) {
      return res.status(422).json({
        error: 'Self-assessment waiver is not permitted at this stage.',
      });
    }

    const newLog = appendAudit(ev.audit_log, req.user, 'SELF_ASSESSMENT_WAIVED', { note });
    const { rows: [updated] } = await query(
      `UPDATE evaluations
       SET status = 'supervisor_assessment',
           waived_self_assessment_note = $1,
           audit_log = $2,
           updated_at = now()
       WHERE id = $3 RETURNING *`,
      [note.trim(), JSON.stringify(newLog), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/goals-on-behalf  (saveGoalsOnBehalf) ─────────────
const GoalSchema = z.object({
  id:       z.string(),
  outcome:  z.string().min(1),
  measure:  z.string().min(1),
  achieved: z.string().optional().default(''),
  staff:    z.number().nullable().optional(),
  entered_on_behalf: z.boolean().optional(),
});

router.post('/:id/goals-on-behalf', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { goals } = req.body ?? {};

    if (!Array.isArray(goals) || goals.length < 1) {
      return res.status(400).json({ error: 'Goals must be a non-empty array.' });
    }

    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    // App-layer departure check (DB trigger also enforces)
    if (!ev.departure) {
      return res.status(422).json({
        error: 'Goals entered on behalf require a departure record on the evaluation.',
      });
    }

    const waivers = departureWaivers(ev);
    if (!waivers.canSupervisorSaveGoals) {
      return res.status(422).json({
        error: 'Goals-on-behalf is not permitted at this stage.',
      });
    }

    // Mark all goals as entered_on_behalf
    const taggedGoals = goals.map((g) => ({ ...g, entered_on_behalf: true }));

    const newLog = appendAudit(ev.audit_log, req.user, 'GOALS_SAVED_ON_BEHALF', {});
    const { rows: [updated] } = await query(
      `UPDATE evaluations
       SET goals = $1, status = 'goals_set', audit_log = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [JSON.stringify(taggedGoals), JSON.stringify(newLog), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/waive-employee-sig  (waiveEmployeeSignature) ────────
router.post('/:id/waive-employee-sig', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note } = req.body ?? {};
    if (!note?.trim()) {
      return res.status(400).json({ error: 'note is required to waive a signature.' });
    }

    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.status !== 'signoff') {
      return res.status(422).json({
        error: `Evaluation must be in signoff status (current: ${ev.status}).`,
      });
    }

    // App-layer departure check (DB trigger fn_check_waiver_requires_departure also enforces)
    if (!ev.departure) {
      return res.status(422).json({
        error: 'A waived signature requires a departure record on the evaluation.',
      });
    }

    const waivers = departureWaivers(ev);
    if (!waivers.canWaiveEmployeeSignature) {
      return res.status(422).json({
        error: 'Employee signature waiver is not permitted at this stage.',
      });
    }

    const sigs = await loadSignatures(id, null);
    if (sigs.employee?.signed_at) {
      return res.status(422).json({ error: 'Employee has already signed.' });
    }

    // Insert waived signature (DB trigger validates departure record too)
    await query(
      `INSERT INTO signatures (evaluation_id, slot, signer_id, signer_name, signer_role, type, note)
       VALUES ($1, 'employee', $2, $3, $4, 'waived', $5)`,
      [id, req.user.id, req.user.name, req.user.role, note.trim()]
    );

    // Check if all 3 sign-off slots are now filled
    const updatedSigs = await loadSignatures(id, null);
    const allSigned =
      !!updatedSigs.employee &&
      !!updatedSigs.supervisor &&
      !!updatedSigs.hr_officer;

    const newStatus = allSigned ? 'hr_review' : 'signoff';
    const newLog = appendAudit(ev.audit_log, req.user, 'EMPLOYEE_SIGNATURE_WAIVED', {
      note,
      waivedBy: req.user.name,
    });

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = $1, audit_log = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [newStatus, JSON.stringify(newLog), id]
    );

    res.json({ ...updated, signatures: updatedSigs });
  } catch (err) {
    // Surface DB trigger error (departure check) as 422
    if (err.message?.includes('departure record')) {
      return res.status(422).json({ error: err.message });
    }
    next(err);
  }
});

// GET /evaluations/:id/pdf — serves the archived copy once finalized, a live one before that
router.get('/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const data = await loadEvalForPdf(id);
    if (!data) return res.status(404).json({ error: `Evaluation ${id} not found.` });
    const { ev, sigs } = data;

    const allowed =
      ['admin', 'hr_officer', 'executive'].includes(req.user.role) ||
      ev.employee_id === req.user.id || ev.supervisor_id === req.user.id;
    if (!allowed) return res.status(403).json({ error: 'Forbidden.' });

    let pdf;
    const { rows: arch } = await query('SELECT pdf FROM evaluation_archives WHERE evaluation_id = $1', [id]);
    if (arch[0]) {
      pdf = arch[0].pdf;
    } else {
      if (!ALL_SLOTS.every((s) => sigs[s])) {
        return res.status(422).json({ error: 'The PDF is available once HR has signed.' });
      }
      pdf = await buildPdfBuffer(data);
      if (ev.status === 'locked') {
        await query(
          `INSERT INTO evaluation_archives (evaluation_id, pdf, created_by)
           VALUES ($1,$2,$3) ON CONFLICT (evaluation_id) DO NOTHING`,
          [id, pdf, req.user.id]
        );
      }
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="evaluation-${id.replace(/[^\w.-]/g, '_')}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('PDF route failed:', err);
    next(err);
  }
});

export default router;
