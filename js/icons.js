import icons from './icons-data.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function setAttrs(el, attrs) {
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
}

export function icon(name, { size = 20, label = null } = {}) {
  if (!Object.hasOwn(icons, name)) throw new Error(`Unknown icon: ${name}`);

  const svg = document.createElementNS(SVG_NS, 'svg');
  setAttrs(svg, {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: 'icon',
  });
  if (label === null) {
    setAttrs(svg, { 'aria-hidden': 'true', focusable: 'false' });
  } else {
    setAttrs(svg, { role: 'img', 'aria-label': label });
  }

  for (const [tag, attrs] of icons[name]) {
    const el = document.createElementNS(SVG_NS, tag);
    setAttrs(el, attrs);
    svg.appendChild(el);
  }
  return svg;
}
