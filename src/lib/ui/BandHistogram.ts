import type { BandStats } from '../raster/stats';
import { el, svgEl } from './dom';

const HANDLE_SIZE = 12;

export type BandHistogramOptions = {
  /** CSS color for the histogram bars. RGB rows pass channel-tinted colors;
   * single-band defaults to a neutral dark. */
  color?: string;
  height?: number;
  /** Optional label rendered above the chart (e.g. "R", "G", "B"). */
  label?: string;
  /** Called continuously while a handle is dragged. */
  onChange: (next: [number, number]) => void;
  /** Drag lifecycle hooks so the host can defer re-renders mid-drag. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
};

/**
 * SVG histogram + HTML handle overlays for a rescale range, ported from
 * cog-viewer's React BandHistogram to imperative DOM. The SVG bars stretch
 * to fill the width via `preserveAspectRatio="none"`; the handles themselves
 * are absolutely-positioned `<div>`s so they stay perfectly circular
 * regardless of the container's aspect ratio.
 *
 * Bar heights use log(1+count) so heavily skewed distributions (a single
 * huge bin near zero plus a long thin tail) stay readable.
 */
export class BandHistogram {
  /** Root element to insert into the panel. */
  readonly el: HTMLElement;

  private _opts: Required<Pick<BandHistogramOptions, 'color' | 'height'>> &
    BandHistogramOptions;
  private _wrap: HTMLElement;
  private _svg: SVGSVGElement;
  private _barsGroup: SVGGElement;
  private _selectionRect: SVGRectElement;
  private _loHandle: HTMLElement;
  private _hiHandle: HTMLElement;
  private _stats: BandStats | null = null;
  private _value: [number, number] = [0, 1];
  private _dragging: 'lo' | 'hi' | null = null;

  /**
   * Creates the histogram widget.
   *
   * @param options - Colors, sizing, and change callbacks
   */
  constructor(options: BandHistogramOptions) {
    // The default is a CSS variable so the neutral single-band histogram
    // follows the light/dark theme; colors are applied via style properties
    // (not SVG presentation attributes) because var() only resolves in CSS.
    this._opts = {
      color: 'var(--mlr-histogram-neutral)',
      height: 64,
      ...options,
    };
    const height = this._opts.height;

    this._svg = svgEl('svg', {
      viewBox: `0 0 100 ${height}`,
      preserveAspectRatio: 'none',
      width: '100%',
      height,
    });
    this._svg.classList.add('mlr-histogram-svg');

    const bg = svgEl('rect', { width: 100, height, class: 'mlr-histogram-bg' });
    this._barsGroup = svgEl('g');
    this._barsGroup.style.fill = this._opts.color;
    this._selectionRect = svgEl('rect', {
      x: 0,
      y: 0,
      width: 0,
      height,
      opacity: 0.12,
    });
    this._selectionRect.style.fill = this._opts.color;
    this._svg.append(bg, this._barsGroup, this._selectionRect);

    this._loHandle = this._makeHandle('lo');
    this._hiHandle = this._makeHandle('hi');

    this._wrap = el('div', { className: 'mlr-histogram-wrap' });
    this._wrap.style.height = `${height}px`;
    this._wrap.append(this._svg, this._loHandle, this._hiHandle);

    this._wrap.addEventListener('pointerdown', this._onBackgroundDown);
    this._wrap.addEventListener('pointermove', this._onPointerMove);
    this._wrap.addEventListener('pointerup', this._onPointerUp);
    this._wrap.addEventListener('pointercancel', this._onPointerUp);

    const children: HTMLElement[] = [];
    if (this._opts.label) {
      const label = el('span', {
        className: 'mlr-histogram-label',
        text: this._opts.label,
      });
      label.style.color = this._opts.color;
      children.push(label);
    }
    children.push(this._wrap);
    this.el = el('div', { className: 'mlr-histogram' }, ...children);
  }

  /**
   * Updates the displayed stats and selection range.
   *
   * @param stats - Band min/max + histogram bins
   * @param value - Current [lo, hi] selection in source units
   */
  update(stats: BandStats, value: [number, number]): void {
    const statsChanged = stats !== this._stats;
    this._stats = stats;
    this._value = value;
    if (statsChanged) this._drawBars();
    this._positionHandles();
  }

  /** Sets only the selection range (e.g. while typing in the numeric
   * inputs). */
  setValue(value: [number, number]): void {
    this._value = value;
    this._positionHandles();
  }

  private _makeHandle(which: 'lo' | 'hi'): HTMLElement {
    const handle = el('div', { className: 'mlr-histogram-handle' });
    handle.dataset.handle = which;
    handle.style.width = `${HANDLE_SIZE}px`;
    handle.style.height = `${HANDLE_SIZE}px`;
    handle.style.borderColor = this._opts.color;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      this._beginDrag(which);
    });
    handle.addEventListener('pointermove', this._onPointerMove);
    handle.addEventListener('pointerup', this._onPointerUp);
    handle.addEventListener('pointercancel', this._onPointerUp);
    return handle;
  }

  private _beginDrag(which: 'lo' | 'hi'): void {
    this._dragging = which;
    this._wrap.classList.add('dragging');
    this._opts.onDragStart?.();
  }

  private _endDrag(): void {
    if (!this._dragging) return;
    this._dragging = null;
    this._wrap.classList.remove('dragging');
    this._opts.onDragEnd?.();
  }

  /** Click on the chart background → snap nearest handle and continue as a
   * drag. */
  private _onBackgroundDown = (e: PointerEvent): void => {
    const target = e.target as HTMLElement;
    if (target.dataset?.handle) return;
    if (!this._stats) return;
    const v = this._xToValue(e.clientX);
    const [lo, hi] = this._sortedValue();
    const which: 'lo' | 'hi' =
      Math.abs(v - lo) <= Math.abs(v - hi) ? 'lo' : 'hi';
    this._applyDrag(which, v);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    this._beginDrag(which);
  };

  private _onPointerMove = (e: PointerEvent): void => {
    if (!this._dragging) return;
    this._applyDrag(this._dragging, this._xToValue(e.clientX));
  };

  private _onPointerUp = (e: PointerEvent): void => {
    if (!this._dragging) return;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    this._endDrag();
  };

  private _applyDrag(which: 'lo' | 'hi', v: number): void {
    const [lo, hi] = this._sortedValue();
    const next: [number, number] =
      which === 'lo' ? [Math.min(v, hi), hi] : [lo, Math.max(v, lo)];
    this._value = next;
    this._positionHandles();
    this._opts.onChange(next);
  }

  private _sortedValue(): [number, number] {
    return [
      Math.min(this._value[0], this._value[1]),
      Math.max(this._value[0], this._value[1]),
    ];
  }

  private _toFrac(v: number): number {
    if (!this._stats) return 0;
    const range = this._stats.max - this._stats.min;
    const safeRange = range > 0 ? range : 1;
    return Math.max(0, Math.min(1, (v - this._stats.min) / safeRange));
  }

  private _xToValue(clientX: number): number {
    if (!this._stats) return 0;
    const rect = this._wrap.getBoundingClientRect();
    if (rect.width === 0) return this._stats.min;
    const fx = (clientX - rect.left) / rect.width;
    const range = this._stats.max - this._stats.min;
    const safeRange = range > 0 ? range : 1;
    return this._stats.min + Math.max(0, Math.min(1, fx)) * safeRange;
  }

  private _drawBars(): void {
    if (!this._stats) return;
    const height = this._opts.height;
    while (this._barsGroup.firstChild) {
      this._barsGroup.removeChild(this._barsGroup.firstChild);
    }
    let maxBin = 0;
    for (const c of this._stats.histogram) if (c > maxBin) maxBin = c;
    const logMaxBin = Math.log1p(maxBin) || 1;
    const w = 100 / this._stats.histogram.length;
    this._stats.histogram.forEach((count, i) => {
      const h = (Math.log1p(count) / logMaxBin) * (height - 4);
      if (h <= 0) return;
      this._barsGroup.appendChild(
        svgEl('rect', {
          x: i * w,
          y: height - h,
          width: w,
          height: h,
          opacity: 0.55,
        }),
      );
    });
  }

  private _positionHandles(): void {
    const [lo, hi] = this._sortedValue();
    const loFrac = this._toFrac(lo);
    const hiFrac = this._toFrac(hi);
    this._loHandle.style.left = `${loFrac * 100}%`;
    this._hiHandle.style.left = `${hiFrac * 100}%`;
    this._selectionRect.setAttribute('x', String(loFrac * 100));
    this._selectionRect.setAttribute('width', String((hiFrac - loFrac) * 100));
  }
}
