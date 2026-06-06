/**
 * Tiny imperative DOM helpers used by the panel UI components. They replace
 * the JSX layer of the cog-viewer implementation this plugin is ported from.
 */

type ElProps = {
  className?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  attrs?: Record<string, string>;
};

/**
 * Creates an HTML element with common props and children.
 *
 * @param tag - HTML tag name
 * @param props - className/text/title/aria-label/attrs shorthands
 * @param children - Nodes or strings appended in order
 * @returns The created element
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    if (props.className) node.className = props.className;
    if (props.text !== undefined) node.textContent = props.text;
    if (props.title) node.title = props.title;
    if (props.ariaLabel) node.setAttribute('aria-label', props.ariaLabel);
    if (props.type && 'type' in node) {
      (node as unknown as { type: string }).type = props.type;
    }
    if (props.value !== undefined && 'value' in node) {
      (node as unknown as { value: string }).value = props.value;
    }
    if (props.placeholder && 'placeholder' in node) {
      (node as unknown as { placeholder: string }).placeholder = props.placeholder;
    }
    if (props.disabled !== undefined && 'disabled' in node) {
      (node as unknown as { disabled: boolean }).disabled = props.disabled;
    }
    if (props.attrs) {
      for (const [name, value] of Object.entries(props.attrs)) {
        node.setAttribute(name, value);
      }
    }
  }
  node.append(...children);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Creates an SVG element with attributes.
 *
 * @param tag - SVG tag name
 * @param attrs - Attributes applied via setAttribute
 * @returns The created SVG element
 */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      node.setAttribute(name, String(value));
    }
  }
  return node;
}

/**
 * Removes all children from a node.
 *
 * @param node - The node to clear
 */
export function clearEl(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Builds a labeled form field: a caption row plus arbitrary content. Help
 * text becomes a native tooltip on the caption.
 *
 * @param label - Caption text
 * @param content - Field body element
 * @param help - Optional tooltip text
 * @returns The field wrapper element
 */
export function field(
  label: string,
  content: HTMLElement,
  help?: string,
): HTMLElement {
  const caption = el('span', {
    className: 'mlr-field-label',
    text: label,
    title: help,
  });
  return el('div', { className: 'mlr-field' }, caption, content);
}

/**
 * Builds a <select> from options and wires a change handler.
 *
 * @param options - Value/label pairs
 * @param value - Initially selected value
 * @param onChange - Change callback with the selected value
 * @param ariaLabel - Accessible name
 * @returns The select element
 */
export function select(
  options: { value: string; label: string }[],
  value: string,
  onChange: (next: string) => void,
  ariaLabel?: string,
): HTMLSelectElement {
  const node = el('select', { className: 'mlr-select', ariaLabel });
  for (const opt of options) {
    const option = el('option', { text: opt.label });
    option.value = opt.value;
    node.appendChild(option);
  }
  node.value = value;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

/**
 * Formats a number for display in a numeric input. Trims to 2 decimals for
 * |n| >= 1 and 4 significant digits below that, matching typical COG ranges.
 *
 * @param n - The number to format
 * @returns A compact numeric value
 */
export function fmtNumber(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const abs = Math.abs(n);
  if (abs >= 1) return Number(n.toFixed(2));
  return Number(n.toPrecision(4));
}
