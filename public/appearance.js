(() => {
  const storageKey = 'calcite.appearance.v1';
  const themes = ['system','dark','light'];
  const materials = ['liquid','mica','solid'];
  const system = matchMedia('(prefers-color-scheme: dark)');
  const reduce = matchMedia('(prefers-reduced-transparency: reduce), (forced-colors: active)');
  const root = document.documentElement;
  if (window.androidBridge || window.webkit?.messageHandlers?.bridge) root.dataset.platform = 'mobile';
  let nativeWindow;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch { /* Use the startup defaults. */ }
  const legacyTheme = new URLSearchParams(location.search).get('legacyTheme');
  let theme = themes.includes(saved?.theme) ? saved.theme : themes.includes(legacyTheme) ? legacyTheme : 'system';
  let glass = saved?.glass==='subtle'?'mica':materials.includes(saved?.glass)?saved.glass:'liquid';
  let paintFrame;
  let request = 0;

  function apply(notify = true, activeTheme = theme==='system' ? (system.matches?'dark':'light') : theme) {
    if (notify && root.dataset.theme!==activeTheme) {
      root.dataset.appearanceSwitching = '';
      cancelAnimationFrame(paintFrame);
      paintFrame = requestAnimationFrame(()=>{
        paintFrame = requestAnimationFrame(()=>{delete root.dataset.appearanceSwitching;});
      });
    }
    root.dataset.theme = activeTheme;
    root.dataset.glass = glass;
    root.dataset.material = glass==='solid'||reduce.matches?'solid':'glass';
    if (notify) document.dispatchEvent(new Event('calcite-appearance-change'));
  }

  function remember() {
    try { localStorage.setItem(storageKey,JSON.stringify({theme,glass})); } catch { /* The current session stays usable. */ }
  }

  function setMaterial(material) {
    if (root.dataset.windowMaterial===material) return;
    root.dataset.windowMaterial = material;
    document.dispatchEvent(new Event('calcite-window-material-change'));
  }

  async function syncWindow() {
    root.dataset.material = glass==='solid'||reduce.matches?'solid':'glass';
    const id = ++request;
    const fallback = glass==='solid'||reduce.matches ? 'solid' : 'css';
    if (fallback==='solid' || !nativeWindow || !root.dataset.windowMaterial || root.dataset.windowMaterial==='solid') setMaterial(fallback);
    if (!nativeWindow) return;
    try {
      const result = await nativeWindow.setAppearance({theme,glass,reduceTransparency:reduce.matches});
      if (id!==request) return;
      setMaterial(result?.material||fallback);
      if (result && result.theme!==root.dataset.theme) apply(true,result.theme);
    } catch {
      if (id===request) setMaterial(fallback);
    }
  }

  apply(false);
  if (saved?.glass==='subtle'||(!saved && themes.includes(legacyTheme))) remember();
  syncWindow();
  window.calciteAppearance = Object.freeze({
    attach(windowControls,events) {
      if (!windowControls.setAppearance) return;
      nativeWindow=windowControls;
      const setFocus=focused=>root.toggleAttribute('data-window-inactive',!focused);
      setFocus(document.hasFocus());
      events.focus(setFocus);
      syncWindow();
    },
    get current() { return {theme,glass}; },
    set(field,value) {
      if (field==='theme'&&themes.includes(value)) theme = value;
      else if (field==='glass'&&materials.includes(value)) glass = value;
      else return;
      remember();
      apply();
      syncWindow();
    }
  });
  system.addEventListener('change',()=>{if (theme==='system') { apply(); syncWindow(); }});
  reduce.addEventListener('change',syncWindow);
})();
