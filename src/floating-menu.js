const inset = 8;
const gap = 5;
const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
const valid = rect => rect && rect.width > 0 && rect.height > 0 &&
  [rect.top, rect.right, rect.bottom, rect.left].every(Number.isFinite);

export function createFloatingMenu({fail,onOpen}) {
  const layer = document.createElement('div');
  layer.id = 'floating-menus';
  const createPanel = className => {
    const panel = document.createElement('div');
    panel.className = 'feature-menu floating-menu ' + className;
    panel.hidden = true;
    panel.setAttribute('role', 'menu');
    layer.append(panel);
    return panel;
  };
  const main = createPanel('floating-menu-main');
  const child = createPanel('floating-menu-child document-submenu');
  child.id = 'floating-submenu';
  document.body.append(layer);
  const entries = new WeakMap();
  let anchor, returnFocus, active, leave;

  function cancelLeave() {
    clearTimeout(leave);
    leave=undefined;
  }
  function closeChild() {
    cancelLeave();
    if (active) active.setAttribute('aria-expanded', 'false');
    active = undefined;
    child.hidden = true;
    child.replaceChildren();
    child.removeAttribute('aria-label');
  }
  function close(restore = false) {
    if (main.hidden) return;
    closeChild();
    main.hidden = true;
    main.replaceChildren();
    main.removeAttribute('id');
    anchor?.setAttribute('aria-expanded', 'false');
    const target = returnFocus;
    anchor = returnFocus = undefined;
    if (restore && target?.isConnected) target.focus({preventScroll:true});
  }
  function action(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.disabled = Boolean(item.disabled);
    const label = document.createElement('span');
    label.textContent = item.label;
    button.append(label);
    if (item.items) {
      button.dataset.submenu = item.id;
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-controls', child.id);
      button.setAttribute('aria-expanded', 'false');
      const arrow = document.createElement('span');
      arrow.textContent = '›';
      arrow.setAttribute('aria-hidden', 'true');
      button.append(arrow);
    } else if (item.id) button.dataset.menuCommand = item.id;
    if (item.key) {
      const key = document.createElement('kbd');
      key.textContent = item.key;
      button.append(key);
    }
    if (item.danger) button.classList.add('menu-danger');
    entries.set(button, item);
    return button;
  }
  function show(panel, locate) {
    panel.style.opacity = '0';
    panel.hidden = false;
    const {width, height} = panel.getBoundingClientRect();
    const [x,y] = locate(width,height);
    panel.style.left = clamp(x,inset,innerWidth-width-inset) + 'px';
    panel.style.top = clamp(y,inset,innerHeight-height-inset) + 'px';
    panel.style.opacity = '';
  }
  function openChild(button, focus = false) {
    cancelLeave();
    if (active !== button) {
      closeChild();
      const rect = button.getBoundingClientRect();
      if (main.hidden || !valid(rect) || button.disabled) return;
      const item = entries.get(button);
      child.replaceChildren(...item.items.map(action));
      child.setAttribute('aria-label', item.label);
      show(child, width => {
        const right = innerWidth-rect.right-inset-gap;
        const left = rect.left-inset-gap;
        return [right >= width || right >= left ? rect.right+gap : rect.left-gap-width, rect.top];
      });
      active = button;
      button.setAttribute('aria-expanded', 'true');
    }
    if (focus) child.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  }
  function open({id, label, groups, trigger, point}) {
    close();
    const rect = trigger?.getBoundingClientRect();
    if (trigger && !valid(rect)) return;
    if (!trigger && !point?.every(Number.isFinite)) return;
    onOpen();
    anchor = trigger;
    returnFocus = trigger || document.activeElement;
    main.id = id;
    main.setAttribute('aria-label', label);
    main.replaceChildren(...groups.map(({label, items}) => {
      const group = document.createElement('section');
      group.className = 'document-menu-group';
      group.setAttribute('role', 'group');
      if (label) group.setAttribute('aria-label', label);
      group.append(...items.map(action));
      return group;
    }));
    show(main,(width,height) => {
      if (rect) {
        const below = rect.bottom+gap;
        return [rect.right-width, below+height <= innerHeight-inset ? below : rect.top-gap-height];
      }
      const [x,y] = point;
      return [x+width <= innerWidth-inset ? x : x-width, y+height <= innerHeight-inset ? y : y-height];
    });
    trigger?.setAttribute('aria-expanded', 'true');
    main.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  }
  function scheduleLeave() {
    if (active&&leave===undefined) leave=setTimeout(closeChild,120);
  }
  const buttonAt = target => target.closest?.('button[role="menuitem"]');
  document.addEventListener('pointerover',event => {
    if (main.hidden) return;
    const target = event.target;
    if (child.contains(target)) {cancelLeave();return;}
    const button = main.contains(target) && buttonAt(target);
    if (button) {
      if (entries.get(button)?.items) openChild(button);
      else closeChild();
    } else scheduleLeave();
  },true);
  document.addEventListener('pointerout',event => {
    if (!event.relatedTarget) scheduleLeave();
  },true);
  function dismissOutside(event) {
    if (!layer.contains(event.target) && !anchor?.contains(event.target)) close();
  }
  document.addEventListener('pointerdown',dismissOutside,true);
  document.addEventListener('click',dismissOutside,true);
  document.addEventListener('contextmenu',() => close(),true);
  main.addEventListener('scroll',closeChild,{capture:true,passive:true});
  main.addEventListener('wheel',closeChild,{passive:true});
  window.addEventListener('blur',() => close());
  window.addEventListener('resize',() => close());
  document.addEventListener('keydown',event => {
    if (main.hidden || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close(true);
  },true);
  layer.addEventListener('click',event => {
    const button = buttonAt(event.target);
    const item = entries.get(button);
    if (!item || button.disabled) return;
    event.stopPropagation();
    if (item.items) {openChild(button,event.detail===0);return;}
    close(true);
    Promise.resolve().then(item.run).catch(fail);
  });
  layer.addEventListener('keydown',event => {
    const button = buttonAt(event.target);
    if (!button) return;
    const inChild = child.contains(button);
    const key = event.key;
    if (key==='Tab') {close(true);return;}
    if (key==='ArrowRight' && entries.get(button)?.items) {
      event.preventDefault();openChild(button,true);return;
    }
    if (key==='ArrowLeft' && inChild) {
      event.preventDefault();
      const parent = active;
      closeChild();
      parent?.focus({preventScroll:true});
      return;
    }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(key)) return;
    event.preventDefault();
    const buttons = [...(inChild?child:main).querySelectorAll('button:not(:disabled)')];
    const next = key==='Home'?0:key==='End'?buttons.length-1:
      (buttons.indexOf(button)+buttons.length+(key==='ArrowDown'?1:-1))%buttons.length;
    if (!inChild) closeChild();
    buttons[next]?.focus({preventScroll:true});
  });
  return {open, close, isOpen: id => !main.hidden && main.id===id};
}

export function contextMenu(menu,event,id,label,groups) {
  event.preventDefault();
  const rect = event.target.getBoundingClientRect();
  const point = event.clientX || event.clientY ? [event.clientX,event.clientY] :
    valid(rect) ? [rect.left,rect.bottom] : null;
  if (groups.length && point) menu.open({id,label,groups,point});
}
