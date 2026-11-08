export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k.toLowerCase() === 'style') throw new Error('Inline styles are not allowed');
      if (v === false || v === null || v === undefined) continue;
      if (k.toLowerCase().startsWith('on') && typeof v !== 'function') {
        throw new Error('Event handler props must be functions');
      }
      if (k === 'class') {
        el.className = v;
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v);
      } else if (k === 'value' || k === 'checked') {
        el[k] = v;
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function appendChildren(el, children) {
  for (const c of children) {
    if (Array.isArray(c)) {
      appendChildren(el, c);
    } else if (c === null || c === undefined || c === false) {
      continue;
    } else if (c instanceof Node) {
      el.appendChild(c);
    } else {
      el.appendChild(document.createTextNode(String(c)));
    }
  }
}
