/* ============================================================
   ui/gen-panels.js — builders DOM dos painéis
     - Treino  (sub-modos A: cadência contínua / B: RNG hit)
     - Gen 3   (Pre-Timer / Target Frame / Calibration / Frame Hit)
     - Gen 4   (Calibrated Delay/Second, Target Delay/Second, Delay Hit)
     - Gen 5   (Mode select, Target Second/Delay, Calibration, Hits)
     - Custom  (lista dinâmica de fases)
   Cada builder retorna um Element pronto pra ir no #panels.
   Os valores ficam em state[name] e gravam de volta on input.
   ============================================================ */

// ─── helpers ──────────────────────────────────────────────────
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  // attrs default-treats both undefined E null (= chamadas como el('span', null, txt) funcionam).
  attrs = attrs || {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v === false || v == null) {}
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) {
    if (k == null) continue;
    e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  }
  return e;
}
function field(label, input) {
  return el('div', { class: 'form-field' },
    el('label', { class: 'form-field-label' }, label),
    input);
}
function intInput(value, onInput, attrs = {}) {
  const i = el('input', { type: 'number', class: 'int-input', step: '1', ...attrs });
  i.value = value ?? '';
  i.addEventListener('input', () => onInput(i.value === '' ? null : parseInt(i.value, 10)));
  return i;
}
function selectInput(options, value, onChange) {
  const s = el('select', { class: 'enum-select' });
  for (const o of options) {
    const opt = el('option', { value: o.value }, o.label);
    if (o.value === value) opt.selected = true;
    s.appendChild(opt);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
function wrapInScrollArea(...children) {
  return el('div', { class: 'panel-scroll-area' }, ...children);
}
function panel(...children) {
  return el('div', { class: 'timer-panel' }, ...children);
}

// v1.12.6: helper de UI compartilhado entre Gen3/4/5 pra "Próximos targets em
// sequência" — mesmo padrão do queue do Treino. Cada item da fila é um snapshot
// dos campos do target atual; quando dá Play, primary + fila são processados em
// ordem, e suas phases concatenadas formam a sessão completa.
//
// `summarizeFn` recebe um snapshot e devolve a string de label.
// `cloneFn` recebe o objeto state principal (g) e devolve um snapshot pra adicionar.
// `requestPreview` é chamado quando a fila muda (pra atualizar o display do timer).
function targetQueueSection(g, summarizeFn, cloneFn, requestPreview) {
  if (!Array.isArray(g.targetQueue)) g.targetQueue = [];

  const wrap = el('div', { style: 'margin-top:14px;padding:8px;background:rgba(127,127,127,.06);border-radius:4px' });
  wrap.appendChild(el('div', { style: 'font-weight:600;font-size:.92em;margin-bottom:6px' },
    'Próximos targets em sequência'));
  wrap.appendChild(el('div', { style: 'opacity:.7;font-size:.83em;margin-bottom:6px' },
    'O target acima é o stage 1. Adicione abaixo pra encadear stages 2, 3, … As phases de todos rodam em sequência sem gap.'));

  const list = el('div', { style: 'display:flex;flex-direction:column;gap:4px;margin-bottom:6px' });
  const renderList = () => {
    list.innerHTML = '';
    if (g.targetQueue.length === 0) {
      list.appendChild(el('div', { style: 'opacity:.5;font-style:italic;font-size:.85em' },
        '(Nenhum target encadeado — só o de cima roda.)'));
      return;
    }
    g.targetQueue.forEach((snap, idx) => {
      const removeBtn = el('button', {
        class: 'btn btn-icon',
        style: 'background:rgba(208,74,59,.18);color:#d04a3b;border:1px solid rgba(208,74,59,.4);min-width:28px',
        title: 'Remover',
        onclick: () => { g.targetQueue.splice(idx, 1); renderList(); if (requestPreview) requestPreview(); },
      }, '×');
      const row = el('div', {
        style: 'display:flex;gap:6px;align-items:center;padding:4px 8px;background:rgba(127,127,127,.06);border-radius:3px'
      },
        el('span', { style: 'min-width:22px;font-weight:600;opacity:.65;font-size:.85em' }, String(idx + 2) + '.'),
        el('span', { style: 'flex:1;font-size:.88em' }, summarizeFn(snap)),
        removeBtn,
      );
      list.appendChild(row);
    });
  };
  renderList();
  wrap.appendChild(list);

  const addBtn = el('button', {
    class: 'btn btn-primary',
    onclick: () => {
      g.targetQueue.push(cloneFn(g));
      renderList();
      if (requestPreview) requestPreview();
    },
  }, '+ Adicionar config atual como próximo target');
  wrap.appendChild(addBtn);

  if (g.targetQueue.length > 0) {
    const clearBtn = el('button', {
      class: 'btn',
      style: 'margin-top:4px;background:rgba(208,74,59,.12);color:#d04a3b;margin-left:6px',
      onclick: () => {
        if (confirm('Limpar toda a fila de ' + g.targetQueue.length + ' target(s)?')) {
          g.targetQueue = [];
          renderList();
          if (requestPreview) requestPreview();
        }
      },
    }, 'Limpar fila');
    wrap.appendChild(clearBtn);
  }

  return wrap;
}

// Hook global pra que o app principal possa pedir preview do timer (quando inputs
// mudam). gen-panels não importa app.js, então usamos uma callback registrada via
// window.__phillRequestHuntPreview (setada no init do app).
function _requestPreview() {
  if (typeof window !== 'undefined' && typeof window.__phillRequestHuntPreview === 'function') {
    window.__phillRequestHuntPreview();
  }
}

// v1.12.5: checkbox "Usar cadência do Treino" — controla o padrão de beats.
//
//   OFF (default, EonTimer-style): countdown beeps pro fim de cada fase.
//          Settings → "Beeps de countdown" controla interval (default 500ms) e
//          count (default 6). Último beep é frame-perfect com o fim da fase;
//          os anteriores ocupam os (count-1)*interval ms precedentes. Antes
//          disso = silêncio. (Idêntico ao default do EonTimer.)
//   ON:    Cadência contínua no BPM do Treino atravessa toda a sessão + alarms
//          de fim de fase. Útil pra praticar timing num pulso fixo.
function cadenceCheckbox(stateObj) {
  const cb = el('input', { type: 'checkbox' });
  cb.checked = !!stateObj.useCadence;
  cb.addEventListener('change', () => { stateObj.useCadence = cb.checked; });
  return el('div', { class: 'form-field', style: 'margin-top:14px;padding:8px;background:rgba(127,127,127,.06);border-radius:4px' },
    el('label', { style: 'display:flex;gap:8px;align-items:flex-start;cursor:pointer' },
      cb,
      el('div', { style: 'display:flex;flex-direction:column;gap:2px' },
        el('span', null, 'Usar cadência do Treino (BPM constante)'),
        el('span', { style: 'opacity:.6;font-size:.85em' },
          'OFF (default, EonTimer-style): countdown beeps no fim de cada fase (configurável em Settings → "Beeps de countdown"). ON: cadência do Treino sobreposta + alarms de fim de fase.'),
      ),
    ),
  );
}

// ─── TREINO ───────────────────────────────────────────────────
// v1.10: a aba Treino agora é o painel de FEEDBACK INFORMACIONAL da sessão (não
// mais o resumo de config -- aquilo virou só uma linha compacta no topo).
//
// O ponto disso: priorizar o tamanho/centralização do display de cadência (em cima)
// e usar a aba pra mostrar o que importa em tempo real: stats acumuladas, breakdown
// por tier, e history das últimas tentativas. Pra editar config: ⚙ Settings.
export function buildTrainingPanel(state) {
  state.training ??= { submode: 'A', bpm: 120, beatsPerCycle: 6, sound: 'beep' };
  const t = state.training;

  // Linha de cabeçalho compacta -- só o essencial pra você saber em qual config tá.
  const cycLen = (t.beatsPerCycle ?? 6);
  let durBrief;
  if (t.submode === 'B') {
    const m = t.durationMode || 'cycles';
    if (m === 'time') durBrief = (t.durationSec ?? 60) + 's';
    else if (m === 'continuous') durBrief = '∞';
    else durBrief = (t.numCycles ?? 1) + ' ciclos × ' + cycLen + 'b';
  } else {
    const m = t.durationMode || 'continuous';
    if (m === 'time') durBrief = (t.durationSec ?? 60) + 's';
    else if (m === 'beats') durBrief = (t.durationBeats ?? 64) + ' beats';
    else durBrief = '∞';
  }
  const queueLen = Array.isArray(t.queue) ? t.queue.length : 0;
  const queueBrief = queueLen ? '  +' + queueLen + ' na fila' : '';
  const header = el('div', { style: 'font-size:.85em;opacity:.7;padding:6px 8px;border-bottom:1px solid rgba(127,127,127,.18);text-align:center' },
    'Modo ' + (t.submode || 'A') + ' · ' + (t.bpm ?? 120) + ' BPM · ' + durBrief + queueBrief + '  ·  ⚙ Settings pra alterar'
  );

  // Slot onde renderSessionStats vai injetar o conteúdo. ID estável.
  const statsSlot = el('div', {
    id: 'trainingPanelStats',
    style: 'padding:8px 12px;flex:1;overflow:auto;display:flex;flex-direction:column;gap:4px'
  });

  // Placeholder enquanto a sessão não tem dados. renderSessionStats() substitui isso
  // assim que o primeiro tap acontecer.
  const placeholder = el('div', {
    style: 'opacity:.55;font-style:italic;text-align:center;padding:14px;font-size:.9em'
  }, 'Stats da sessão aparecem aqui durante o treino (após o 1º tap).');
  statsSlot.appendChild(placeholder);

  return panel(header, statsSlot);
}

// ─── GEN 3 ────────────────────────────────────────────────────
export function buildGen3Panel(state) {
  const g = state.gen3 ??= {
    mode: 'STANDARD',
    preTimer: 5000,
    targetFrame: 1500,
    calibration: 0,
    frameHit: null,
    useCadence: false,
    targetQueue: [],
  };
  if (g.useCadence === undefined) g.useCadence = false;
  if (!Array.isArray(g.targetQueue)) g.targetQueue = [];
  const modeSel = selectInput(
    [{ value: 'STANDARD', label: 'Standard' }],
    g.mode, v => { g.mode = v; _requestPreview(); }
  );
  const fields = el('div', { class: 'panel-form-group' },
    field('Mode', modeSel),
    el('div', { class: 'custom-phase-group' },
      el('div', { class: 'custom-phase-fields' },
        field('Pre-Timer',    intInput(g.preTimer,    v => { g.preTimer    = v ?? g.preTimer;    _requestPreview(); })),
        field('Target Frame', intInput(g.targetFrame, v => { g.targetFrame = v ?? g.targetFrame; _requestPreview(); })),
        field('Calibration',  intInput(g.calibration, v => { g.calibration = v ?? g.calibration; _requestPreview(); })),
      )
    ),
  );
  const hitGroup = el('div', { class: 'panel-hit-fields' },
    field('Frame Hit', intInput(g.frameHit, v => g.frameHit = v, { placeholder: 'Enter frame hit' })),
  );
  const queueSection = targetQueueSection(g,
    (s) => 'Pre=' + (s.preTimer ?? 0) + 'ms · Frame=' + (s.targetFrame ?? 0) + ' · Cal=' + (s.calibration ?? 0),
    (cur) => ({ mode: cur.mode, preTimer: cur.preTimer, targetFrame: cur.targetFrame, calibration: cur.calibration }),
    _requestPreview,
  );
  return panel(wrapInScrollArea(fields, hitGroup, cadenceCheckbox(g), queueSection));
}

// ─── GEN 4 ────────────────────────────────────────────────────
export function buildGen4Panel(state) {
  const g = state.gen4 ??= {
    calibratedDelay: 500,
    calibratedSecond: 14,
    targetDelay: 600,
    targetSecond: 50,
    delayHit: null,
    useCadence: false,
    targetQueue: [],
  };
  if (g.useCadence === undefined) g.useCadence = false;
  if (!Array.isArray(g.targetQueue)) g.targetQueue = [];
  const fields = el('div', { class: 'panel-form-group' },
    el('div', { class: 'custom-phase-group' },
      el('div', { class: 'custom-phase-fields' },
        field('Calibrated Delay',  intInput(g.calibratedDelay,  v => { g.calibratedDelay  = v ?? g.calibratedDelay;  _requestPreview(); })),
        field('Calibrated Second', intInput(g.calibratedSecond, v => { g.calibratedSecond = v ?? g.calibratedSecond; _requestPreview(); })),
        field('Target Delay',      intInput(g.targetDelay,      v => { g.targetDelay      = v ?? g.targetDelay;      _requestPreview(); })),
        field('Target Second',     intInput(g.targetSecond,     v => { g.targetSecond     = v ?? g.targetSecond;     _requestPreview(); })),
      )
    ),
  );
  const hitGroup = el('div', { class: 'panel-hit-fields' },
    field('Delay Hit', intInput(g.delayHit, v => g.delayHit = v, { placeholder: 'Enter delay hit' })),
  );
  const queueSection = targetQueueSection(g,
    (s) => 'CalDly=' + (s.calibratedDelay ?? 0) + ' · CalSec=' + (s.calibratedSecond ?? 0)
         + ' · TgtDly=' + (s.targetDelay ?? 0) + ' · TgtSec=' + (s.targetSecond ?? 0),
    (cur) => ({
      calibratedDelay:  cur.calibratedDelay,
      calibratedSecond: cur.calibratedSecond,
      targetDelay:      cur.targetDelay,
      targetSecond:     cur.targetSecond,
    }),
    _requestPreview,
  );
  return panel(wrapInScrollArea(fields, hitGroup, cadenceCheckbox(g), queueSection));
}

// ─── GEN 5 ────────────────────────────────────────────────────
export function buildGen5Panel(state) {
  const g = state.gen5 ??= {
    mode: 'STANDARD',
    targetSecond: 0,
    calibration: 0,
    targetDelay: 1200,
    targetAdvances: 100,
    entralinkCalibration: 0,
    frameCalibration: 0,
    secondHit: null,
    useCadence: false,
    targetQueue: [],
  };
  if (g.useCadence === undefined) g.useCadence = false;
  if (!Array.isArray(g.targetQueue)) g.targetQueue = [];
  const modeOpts = [
    { value: 'STANDARD',         label: 'Standard' },
    { value: 'C_GEAR',           label: 'C-Gear' },
    { value: 'ENTRALINK',        label: 'Entralink' },
    { value: 'ENTRALINK_PLUS',   label: 'Entralink+' },
  ];
  const modeSel = selectInput(modeOpts, g.mode, v => { g.mode = v; rerender(); _requestPreview(); });

  const inner = el('div', { class: 'custom-phase-group' });
  const innerFields = el('div', { class: 'custom-phase-fields' });
  inner.appendChild(innerFields);

  function rerender() {
    innerFields.innerHTML = '';
    innerFields.appendChild(field('Target Second', intInput(g.targetSecond, v => { g.targetSecond = v ?? g.targetSecond; _requestPreview(); })));
    innerFields.appendChild(field('Calibration',   intInput(g.calibration,   v => { g.calibration   = v ?? g.calibration;   _requestPreview(); })));
    if (g.mode === 'ENTRALINK' || g.mode === 'ENTRALINK_PLUS') {
      innerFields.appendChild(field('Target Delay',          intInput(g.targetDelay,          v => { g.targetDelay          = v ?? g.targetDelay;          _requestPreview(); })));
      innerFields.appendChild(field('Target Advances',       intInput(g.targetAdvances,       v => { g.targetAdvances       = v ?? g.targetAdvances;       _requestPreview(); })));
      innerFields.appendChild(field('Entralink Calibration', intInput(g.entralinkCalibration, v => { g.entralinkCalibration = v ?? g.entralinkCalibration; _requestPreview(); })));
    }
    if (g.mode === 'ENTRALINK_PLUS') {
      innerFields.appendChild(field('Frame Calibration', intInput(g.frameCalibration, v => { g.frameCalibration = v ?? g.frameCalibration; _requestPreview(); })));
    }
  }
  rerender();

  const fields = el('div', { class: 'panel-form-group' },
    field('Mode', modeSel),
    inner,
  );
  const hitGroup = el('div', { class: 'panel-hit-fields' },
    field('Second Hit', intInput(g.secondHit, v => g.secondHit = v, { placeholder: 'Enter second hit' })),
  );
  const queueSection = targetQueueSection(g,
    (s) => {
      const base = 'Mode=' + s.mode + ' · TgtSec=' + (s.targetSecond ?? 0) + ' · Cal=' + (s.calibration ?? 0);
      if (s.mode === 'ENTRALINK' || s.mode === 'ENTRALINK_PLUS') {
        const extra = ' · TgtDly=' + (s.targetDelay ?? 0) + ' · TgtAdv=' + (s.targetAdvances ?? 0)
                    + ' · EntCal=' + (s.entralinkCalibration ?? 0);
        if (s.mode === 'ENTRALINK_PLUS') return base + extra + ' · FrCal=' + (s.frameCalibration ?? 0);
        return base + extra;
      }
      return base;
    },
    (cur) => ({
      mode:                 cur.mode,
      targetSecond:         cur.targetSecond,
      calibration:          cur.calibration,
      targetDelay:          cur.targetDelay,
      targetAdvances:       cur.targetAdvances,
      entralinkCalibration: cur.entralinkCalibration,
      frameCalibration:     cur.frameCalibration,
    }),
    _requestPreview,
  );
  return panel(wrapInScrollArea(fields, hitGroup, cadenceCheckbox(g), queueSection));
}

// ─── CUSTOM ───────────────────────────────────────────────────
export function buildCustomPanel(state) {
  const c = state.custom ??= {
    phases: [
      { unit: 'ms',       target: 5000,  calibration: 0, hit: null },
      { unit: 'advances', target: 1000,  calibration: 0, hit: null },
    ],
    useCadence: false,
  };
  if (c.useCadence === undefined) c.useCadence = false;

  const list = el('div', { class: 'custom-scroll' });

  function renderList() {
    list.innerHTML = '';
    c.phases.forEach((ph, idx) => {
      const removeBtn = el('button', { class: 'btn btn-danger btn-icon', title: 'Remove' }, '✕');
      removeBtn.onclick = () => {
        c.phases.splice(idx, 1);
        if (c.phases.length === 0) c.phases.push({ unit: 'ms', target: 0, calibration: 0, hit: null });
        renderList();
        _requestPreview();
      };
      const unitRow = el('div', { class: 'custom-unit-row' },
        selectInput([
          { value: 'ms',       label: 'ms' },
          { value: 'advances', label: 'Advances' },
        ], ph.unit, v => { ph.unit = v; _requestPreview(); }),
        removeBtn,
      );
      const group = el('div', { class: 'custom-phase-group' },
        el('div', { class: 'custom-phase-fields' },
          field('Unit', unitRow),
          field('Target',      intInput(ph.target,      v => { ph.target      = v ?? ph.target;      _requestPreview(); })),
          field('Calibration', intInput(ph.calibration, v => { ph.calibration = v ?? ph.calibration; _requestPreview(); })),
          field('Hit',         intInput(ph.hit,         v => ph.hit           = v, { placeholder: '' })),
        )
      );
      const row = el('div', { class: 'custom-phase-row' },
        el('div', { class: 'custom-phase-index' }, String(idx + 1) + '.'),
        group,
      );
      list.appendChild(row);
    });
  }
  renderList();

  const addBtn = el('button', { class: 'btn btn-success btn-add', title: 'Add phase' }, '+');
  addBtn.onclick = () => {
    c.phases.push({ unit: 'ms', target: 0, calibration: 0, hit: null });
    renderList();
    _requestPreview();
  };

  // v1.12.7: aviso visual de que Custom é hardcoded em GBA (não usa o console global).
  const consoleNote = el('div', {
    style: 'margin-top:8px;padding:6px 10px;background:rgba(127,127,127,.08);border-radius:4px;font-size:.83em;opacity:.78;line-height:1.4'
  },
    el('strong', null, 'Custom = GBA (fixed). '),
    el('span', null, 'Conversão de Advances → ms usa framerate de GBA (≈ 59.7275 Hz), independente do Console global em Settings → Timer.'),
  );

  return panel(
    wrapInScrollArea(list, consoleNote),
    addBtn,
    cadenceCheckbox(c),
  );
}
