export const isMobileUI = () => document.documentElement.dataset.platform === 'mobile';

export function settingsGroup(label, content) {
  return `<section class="lg-section" aria-label="${label}"><h4>${label}</h4><div class="lg-group">${content}</div></section>`;
}

export function settingToggle(name, label, {checked=false, detail=''}={}) {
  return `<label class="lg-switch-row"><span>${label}${detail ? `<small>${detail}</small>` : ''}</span>
    <input class="lg-switch" role="switch" type="checkbox" name="${name}" ${checked ? 'checked' : ''}></label>`;
}

const layers = [];
const registered = new WeakSet();
const returnFocus = new WeakMap();

export function activeMobileDialog() {
  return layers.findLast(layer => layer.open);
}

export function showDialog(dialog) {
  if (dialog.parentElement !== document.body) document.body.append(dialog);
  if (!isMobileUI()) {
    dialog.showModal();
    return;
  }
  const previous = activeMobileDialog();
  // Keep the caller mounted for confirmation forms and restore its state when they close.
  if (previous && previous !== dialog) {
    const origin = document.activeElement;
    if (origin?.matches('button,summary') && previous.contains(origin)) returnFocus.set(dialog, origin);
    previous.dataset.mobileSuspended = '';
  }
  dialog.showModal();
  const existing = layers.indexOf(dialog);
  if (existing !== -1) layers.splice(existing, 1);
  layers.push(dialog);
  if (registered.has(dialog)) return;
  registered.add(dialog);
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    const index = layers.indexOf(dialog);
    if (index !== -1) layers.splice(index, 1);
    delete dialog.dataset.mobileSuspended;
    const active = activeMobileDialog();
    if (active) {
      delete active.dataset.mobileSuspended;
      const origin = returnFocus.get(dialog);
      if (origin && active.contains(origin)) origin.focus({preventScroll:true});
    }
    returnFocus.delete(dialog);
  });
}
