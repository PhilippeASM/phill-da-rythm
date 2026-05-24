// audio.js — AudioContext, sons EonTimer e beeps.
// Carrega assets/sounds/{beep,ding,pop,tick}.wav e os agenda com sample-accurate
// timing via Web Audio (AudioBufferSourceNode). Mantém um beep sintetizado
// como fallback caso os assets não estejam disponíveis.
//
// Os arquivos .wav são portados do repo DasAmpharos/EonTimer (src/audio/).

let _actx = null;
const _buffers = new Map();
let _loadPromise = null;

export const Sound = Object.freeze({
  BEEP: 'beep',
  DING: 'ding',
  POP:  'pop',
  TICK: 'tick',
});

// Caminho base relativo ao index.html do app (não ao módulo).
// Pode ser sobrescrito antes do primeiro loadSounds() via setSoundsPath().
let _soundsPath = 'assets/sounds/';
export function setSoundsPath(p) { _soundsPath = p.endsWith('/') ? p : p + '/'; }

export function ensureAudio() {
  if (!_actx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API não disponível');
    _actx = new Ctor();
  }
  // resume cobre 'suspended' E o estado iOS-específico 'interrupted' (pós-background).
  if (_actx.state !== 'running' && _actx.state !== 'closed') {
    try { _actx.resume(); } catch (e) {}
  }
  return _actx;
}

export function getCtx() { return _actx; }
export function now()    { return _actx ? _actx.currentTime : 0; }
export function audioState() { return _actx ? _actx.state : 'none'; }

// Carrega e decodifica todos os 4 sons EonTimer. Idempotente: chamadas
// múltiplas retornam a mesma Promise. Resolve com Set de nomes carregados
// (subset de {beep,ding,pop,tick}). Falhas individuais são silenciosas:
// o som correspondente cai pro fallback sintetizado.
export function loadSounds(names = ['beep','ding','pop','tick']) {
  if (_loadPromise) return _loadPromise;
  ensureAudio();
  _loadPromise = (async () => {
    const loaded = new Set();
    await Promise.all(names.map(async (name) => {
      try {
        const r = await fetch(_soundsPath + name + '.wav');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const ab = await r.arrayBuffer();
        const buf = await _actx.decodeAudioData(ab);
        _buffers.set(name, buf);
        loaded.add(name);
      } catch (e) {
        console.warn('[audio] falhou carregar', name, e.message);
      }
    }));
    return loaded;
  })();
  return _loadPromise;
}

export function hasSound(name) { return _buffers.has(name); }

// Toca um som no tempo absoluto 'when' (actx.currentTime + offset).
// opts: { gain=1 }.
// Se o som não foi carregado, faz fallback pro beep sintetizado.
// Registry de sources agendadas mas que ainda não tocaram (ou ainda estão tocando).
// Cada source se auto-remove quando termina (onended). cancelAllScheduled() força stop
// em todas as que ainda não terminaram -- usado pelo app.js no stopRound() pra cortar
// imediatamente os beats que estavam na fila do AudioContext.
const _scheduled = new Set();

function _track(node) {
  _scheduled.add(node);
  node.onended = () => _scheduled.delete(node);
  return node;
}

export function cancelAllScheduled() {
  for (const node of _scheduled) {
    try { node.stop(); } catch (e) { /* já parou ou nem começou -- ignorar */ }
  }
  _scheduled.clear();
}

export function play(name, when, opts = {}) {
  ensureAudio();
  const t = (when == null) ? _actx.currentTime : when;
  const buf = _buffers.get(name);
  if (!buf) {
    // fallback
    return beep(t, opts);
  }
  const src = _actx.createBufferSource();
  src.buffer = buf;
  const g = _actx.createGain();
  g.gain.value = opts.gain ?? 1;
  src.connect(g);
  g.connect(_actx.destination);
  src.start(t);
  return _track(src);
}

// Beep sintetizado (fallback ou modo manual). Mesmo envelope da v1.0.
// opts: { freq=1000, type='sine', attack=0.002, decay=0.045, peak=0.4 }
export function beep(when, opts = {}) {
  ensureAudio();
  const { freq = 1000, type = 'sine', attack = 0.002, decay = 0.045, peak = 0.4 } = opts;
  const t = (when == null) ? _actx.currentTime : when;
  const o = _actx.createOscillator();
  const g = _actx.createGain();
  o.type = type;
  o.frequency.value = freq;
  o.connect(g);
  g.connect(_actx.destination);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.start(t);
  o.stop(t + decay + 0.015);
  return _track(o);
}

// Conveniência: agenda 'count' pulsos de um som a partir de 'from', a cada 'period' s.
export function schedulePulses(from, period, count, name = 'beep', opts = {}) {
  for (let i = 0; i < count; i++) play(name, from + i * period, opts);
}

// v1.14: recria o AudioContext do ZERO (+ recarrega os buffers no novo contexto).
// Necessário no iOS: ao voltar de background o contexto pode ficar 'interrupted'/zumbi
// e nem resume() revive — só recriar (= o que o usuário fazia fechando/reabrindo o app).
// AudioBuffers são presos ao contexto, então precisam ser re-decodificados no novo.
export async function reinitAudio() {
  const old = _actx;
  _actx = null;
  _buffers.clear();
  _loadPromise = null;
  _scheduled.clear();
  try { if (old) await old.close(); } catch (e) {}
  ensureAudio();
  try { await loadSounds(); } catch (e) {}
  return _actx ? _actx.state : 'none';
}
