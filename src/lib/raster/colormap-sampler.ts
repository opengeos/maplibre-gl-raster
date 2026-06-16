import { COLORMAP_INDEX } from '@developmentseed/deck.gl-raster/gpu-modules';
import { colormapsPngUrl } from './colormaps';

/** Sprite row width (texels per colormap). */
export const COLORMAP_SPRITE_WIDTH = 256;

// The colormap sprite has one 1px-tall row per colormap. Load it once and
// share the decoded image across every consumer (the picker preview and the
// colorbar), so the PNG is fetched a single time.
let spritePromise: Promise<HTMLImageElement> | null = null;

/**
 * Loads (and memoizes) the colormap sprite PNG.
 *
 * @returns The decoded sprite image, shared across callers.
 */
export function loadColormapSprite(): Promise<HTMLImageElement> {
  if (!spritePromise) {
    spritePromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load colormap sprite'));
      img.src = colormapsPngUrl;
    });
  }
  return spritePromise;
}

/**
 * Whether a name maps to a known colormap row in the sprite.
 *
 * @param name - A colormap name (case-insensitive).
 * @returns True when the name has a sprite row.
 */
export function isKnownColormap(name: string): boolean {
  return (COLORMAP_INDEX as Record<string, number>)[name.toLowerCase()] !== undefined;
}

/**
 * Samples `steps` evenly spaced CSS `rgb()` colors from a named colormap by
 * reading its row of the sprite. `reversed` samples `1 - f`, mirroring the GPU
 * colormap shader, so a reversed legend matches a reversed render exactly.
 *
 * Returns an empty array for an unknown name, for `steps < 2`, or when a 2D
 * canvas is unavailable (e.g. jsdom without the `canvas` package); callers
 * should fall back to a plain gradient in that case.
 *
 * @param name - The colormap name (case-insensitive).
 * @param steps - Number of color stops to sample (>= 2).
 * @param reversed - Sample the ramp back-to-front.
 * @returns Sampled `rgb(r, g, b)` strings, or [] when sampling is impossible.
 */
export async function sampleColormapStops(
  name: string,
  steps: number,
  reversed = false,
): Promise<string[]> {
  const rowIndex = (COLORMAP_INDEX as Record<string, number>)[name.toLowerCase()];
  if (rowIndex === undefined || steps < 2) return [];

  const sprite = await loadColormapSprite();
  const canvas = document.createElement('canvas');
  canvas.width = COLORMAP_SPRITE_WIDTH;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];

  ctx.drawImage(
    sprite,
    0,
    rowIndex,
    COLORMAP_SPRITE_WIDTH,
    1,
    0,
    0,
    COLORMAP_SPRITE_WIDTH,
    1,
  );
  const { data } = ctx.getImageData(0, 0, COLORMAP_SPRITE_WIDTH, 1);

  const stops: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    const f = i / (steps - 1);
    const sample = reversed ? 1 - f : f;
    const x = Math.min(
      COLORMAP_SPRITE_WIDTH - 1,
      Math.max(0, Math.round(sample * (COLORMAP_SPRITE_WIDTH - 1))),
    );
    const o = x * 4;
    stops.push(`rgb(${data[o]}, ${data[o + 1]}, ${data[o + 2]})`);
  }
  return stops;
}
