/* ============================================================
   ui/mode-switcher.js — gerencia as abas (Treino/Gen5/4/3/Custom)
   Monta o painel correspondente em #panels e dispara onChange.
   ============================================================ */

import { buildTrainingPanel } from './gen-panels.js?v=20260514k';
import { buildGen3Panel, buildGen4Panel, buildGen5Panel, buildCustomPanel } from './gen-panels.js?v=20260514k';

const BUILDERS = {
  training: buildTrainingPanel,
  gen3:     buildGen3Panel,
  gen4:     buildGen4Panel,
  gen5:     buildGen5Panel,
  custom:   buildCustomPanel,
};

export function initModeSwitcher({ tabBarEl, panelsEl, state, onChange }) {
  const tabs = Array.from(tabBarEl.querySelectorAll('.tab'));

  function activate(name) {
    tabs.forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    panelsEl.innerHTML = '';
    const build = BUILDERS[name] ?? BUILDERS.training;
    const node  = build(state);
    panelsEl.appendChild(node);
    state.activeMode = name;
    if (typeof onChange === 'function') onChange(name);
  }

  tabs.forEach(t => {
    t.addEventListener('click', () => activate(t.dataset.tab));
  });

  // ativa o padrão (primeira aba marcada como .active no HTML)
  const initial = tabs.find(t => t.classList.contains('active'))?.dataset.tab ?? 'training';
  activate(initial);

  return { activate };
}
