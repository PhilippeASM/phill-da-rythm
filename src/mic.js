// mic.js — Fase A1: captura de microfone + onset detection simples por RMS.
//
// Objetivo: detectar o "click" físico do botão A do Pro Controller quando o controle
// estiver pareado com o Switch (= sem evento de gamepad disponível no laptop). Aqui na
// A1 ainda não há calibração formal; o módulo só EXPORTA os onsets pro app pra você
// comparar com os presses do gamepad (que rolam em paralelo via controller.js).
//
// Pipeline:
//   getUserMedia({audio}) -> MediaStreamSource -> AnalyserNode (fftSize 256) -> poll
//   a cada ~5 ms via setTimeout. Cada poll: getFloatTimeDomainData() -> RMS do buffer
//   -> compara contra EMA do ruído de fundo. Se RMS > k*ema E > floor absoluto, dispara
//   onset (refractory de 80 ms pra não duplicar).
//
// Características das constraints do getUserMedia: AGC, noise suppression e echo
// cancellation DESLIGADOS — esses filtros foram feitos pra fala/reunião e DESTROEM o
// transiente curto do click do botão (que é justamente o que a gente quer detectar).
//
// API:
//   startMic({ onOnset, onError }) -> Promise<stop() | null>
//     onOnset(actxSec, rms): chamado a cada pico de energia detectado
//     onError(err): falha (permissão negada, sem device, AudioContext fechado)
//   stopMic(): libera o stream e para o polling
//   micStats(): diagnóstico (noise floor atual, contagem de samples, etc)
//
// Latência absoluta esperada: ~10-40 ms entre o click físico e a chegada do onset
// aqui dentro (buffer do mic + AnalyserNode + poll). Esse atraso é EXATAMENTE o que a
// Fase A2 vai calibrar contra o `gp.timestamp` do controle ground-truth. Por isso aqui
// na A1 a gente NÃO tenta compensar nada — só registra cru.

import { ensureAudio, getCtx } from './audio.js?v=20260515c';

const FFT_SIZE          = 256;     // 256 samples ≈ 5.3 ms @ 48 kHz: balanceia resolução vs SNR
const POLL_MS           = 5;       // cadência de leitura (≈ FFT_SIZE / sampleRate)
const REFRACTORY_MS     = 80;      // após um onset, ignora novos onsets por X ms
const NOISE_EMA_ALPHA   = 0.02;    // 2% peso do novo sample no EMA do floor
const ONSET_K           = 3.0;     // sensibilidade relativa: rms > k * noise_ema    (v1: 6.0)
const ONSET_FLOOR       = 0.003;   // E rms > floor absoluto (escala -1..1)          (v1: 0.01)
// Só atualiza a noise_ema com samples "quietos" (< 2× ema atual). Isso evita o bug v1
// em que clicks "quase-detectados" (acima do floor relativo mas abaixo do absoluto, ou
// vice-versa) eram somados ao ema e empurravam o floor pra cima ao longo do tempo,
// causando perda crescente de sensibilidade -- e dando a impressão de que o mic
// "desligava" enquanto o controle era usado, e "acordava" quando ele virava idle.
const QUIET_RATIO_FOR_EMA = 2.0;
const FLOOR_LOG_EVERY = 400;       // ticks (≈ 2s a 5ms) entre logs periódicos do floor

let _s = null;

export async function startMic({ onOnset, onError } = {}) {
  if (_s) {
    console.warn('[mic] já está rodando');
    return null;
  }
  try {
    ensureAudio();
    const actx = getCtx();
    if (!actx) throw new Error('AudioContext indisponível');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
        channelCount:     1,
      },
    });
    const source   = actx.createMediaStreamSource(stream);
    const analyser = actx.createAnalyser();
    analyser.fftSize       = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;   // sem suavização -- queremos o pico cru
    source.connect(analyser);             // NÃO conectamos ao destination -- sem playback

    const buf = new Float32Array(analyser.fftSize);

    _s = {
      stream, source, analyser, buf,
      onOnset: onOnset || (() => {}),
      onError: onError || ((e) => console.error('[mic]', e)),
      timeoutId:    0,
      running:      true,
      noiseEma:     ONSET_FLOOR,    // arranca no floor pra não disparar no boot
      lastOnsetMs: -Infinity,        // perf time
      sampleCount: 0,
      onsetCount:  0,
    };

    const tick = () => {
      if (!_s || !_s.running) return;
      _s.analyser.getFloatTimeDomainData(_s.buf);
      let sumSq = 0;
      for (let i = 0; i < _s.buf.length; i++) sumSq += _s.buf[i] * _s.buf[i];
      const rms = Math.sqrt(sumSq / _s.buf.length);
      _s.sampleCount++;

      const isOnsetCandidate = rms > _s.noiseEma * ONSET_K && rms > ONSET_FLOOR;
      const nowMs = performance.now();
      const sinceLast = nowMs - _s.lastOnsetMs;

      if (isOnsetCandidate && sinceLast > REFRACTORY_MS) {
        _s.lastOnsetMs = nowMs;
        _s.onsetCount++;
        const t = actx.currentTime;
        const ratio = _s.noiseEma > 0 ? rms / _s.noiseEma : Infinity;
        const info = { rms, floor: _s.noiseEma, ratio };
        try { _s.onOnset(t, info); } catch (e) { console.warn('[mic] onOnset threw:', e); }
        // Não atualiza noiseEma quando é onset.
      } else if (rms < _s.noiseEma * QUIET_RATIO_FOR_EMA) {
        // SÓ atualiza a ema com samples quietos. Eventos altos que não viraram onset
        // (ex.: click do botão que ficou borderline) NÃO podem subir o floor.
        _s.noiseEma = _s.noiseEma * (1 - NOISE_EMA_ALPHA) + rms * NOISE_EMA_ALPHA;
      }

      // Log periódico do floor pra ver se está estável ou subindo
      if (_s.sampleCount % FLOOR_LOG_EVERY === 0) {
        console.log('[mic floor] ema=' + _s.noiseEma.toFixed(5) + '  (threshold relativo=' +
                    (_s.noiseEma * ONSET_K).toFixed(5) + ', floor absoluto=' + ONSET_FLOOR + ')');
      }

      _s.timeoutId = setTimeout(tick, POLL_MS);
    };
    _s.timeoutId = setTimeout(tick, POLL_MS);

    return () => stopMic();
  } catch (err) {
    const cb = onError || ((e) => console.error('[mic] erro:', e));
    cb(err);
    return null;
  }
}

export function stopMic() {
  if (!_s) return;
  _s.running = false;
  if (_s.timeoutId) clearTimeout(_s.timeoutId);
  try { _s.source.disconnect(); } catch (e) {}
  try { _s.analyser.disconnect(); } catch (e) {}
  if (_s.stream) {
    for (const t of _s.stream.getTracks()) {
      try { t.stop(); } catch (e) {}
    }
  }
  _s = null;
}

export function isMicRunning() {
  return !!(_s && _s.running);
}

// Diagnóstico pra console:
//   window.micStats() -> { running, noiseEma, sampleCount, onsetCount, lastOnsetMs }
export function micStats() {
  if (!_s) return { running: false };
  return {
    running:     _s.running,
    noiseEma:    _s.noiseEma,
    sampleCount: _s.sampleCount,
    onsetCount:  _s.onsetCount,
    lastOnsetMs: _s.lastOnsetMs,
  };
}
