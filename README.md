# Treino de Ritmo — v1.7 (estrutura modular)

Estrutura:
- index.html        : entry-point HTML mínimo
- style.css         : todo o CSS
- src/
  - app.js          : init e glue
  - audio.js        : AudioContext, beeps
  - timing.js       : detecção de beat, tiers, estatísticas, warmup
  - calibrator.js   : framerates e conversão frame↔ms (EonTimer-style)
  - controller.js   : input por Pro Controller / gamepad (Web Gamepad API)
  - timers/         : gen3, gen4, gen5, custom (modos do EonTimer)
  - ui/             : dial SVG, mode switcher, painéis Gen
- versions/         : snapshots imutáveis (v1.6, v1.7, ...)

Servir com qualquer http server: `python -m http.server 8000` na pasta-pai.
Abrir: http://localhost:8000/treino-ritmo/

## Inputs aceitos

- **Espaço (teclado)** — começa/para o timer parado; durante o run, conta como tap.
- **Pro Controller (USB-C) ou qualquer gamepad reconhecido pelo navegador** — mesma
  semântica do espaço: 1º press com timer parado = Start; durante o run, qualquer botão
  conta como tap. O tempo do press é back-datado via `Gamepad.timestamp` quando o
  navegador fornece, pra evitar 1 frame de polling jitter do `requestAnimationFrame`.
  Não precisa fazer nada — plugue o controle, ele aparece no status bar ("Controle
  conectado: …"). Funciona em Chrome/Edge/Firefox modernos.

## Notas de calibração de áudio (futuro, deferido)

A ideia de calibrar a detecção do som do click do botão do controle contra o ground
truth digital do USB-HID (e depois usar essa calibração pra ler timing por mic quando
o controle estiver pareado com o Switch via Bluetooth) está no plano mas **não foi
implementada nesta versão**. Quando vier, mora num módulo separado (`src/mic.js` +
um calibrator dedicado) e não toca no fluxo atual de tap.
