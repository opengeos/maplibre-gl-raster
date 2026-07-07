import { describe, expect, it } from 'vitest';
import {
  Colormap,
  COLORMAP_INDEX,
} from '@developmentseed/deck.gl-raster/gpu-modules';
import type { Texture } from '@luma.gl/core';
import {
  buildIndexCompositeRenderTile,
  buildSingleCompositeRenderTile,
  DEFAULT_INDEX_RANGE,
} from '../src/lib/raster/render-pipeline';
import { NormalizedDifference, PerBandLinearRescale } from '../src/lib/raster/shader-modules';
import { createLayerState } from '../src/lib/state/RasterLayer';
import type { MultiBandTileData } from '../src/lib/raster/tile-loader';

// Minimal tile with a single band. buildCompositeBandsProps only stores the
// textures/uvTransforms into props, so a placeholder texture is fine here.
function fakeTile(): MultiBandTileData {
  return {
    bands: new Map([
      ['1', { texture: {} as Texture, uvTransform: [0, 0, 1, 1] }],
    ]),
    width: 256,
    height: 256,
    byteLength: 0,
    nodata: null,
    sampleScale: 255,
  };
}

// A tile carrying `count` bands (keyed '1'..'count'), for index/RGB paths.
function fakeMultiBandTile(count: number): MultiBandTileData {
  const bands = new Map<string, { texture: Texture; uvTransform: [number, number, number, number] }>();
  for (let b = 1; b <= count; b++) {
    bands.set(String(b), { texture: {} as Texture, uvTransform: [0, 0, 1, 1] });
  }
  return { bands, width: 256, height: 256, byteLength: 0, nodata: null, sampleScale: 255 };
}

function colormapProps(reversed?: boolean): Record<string, unknown> | undefined {
  // Omit `reversed` entirely in the default case so the test exercises
  // createLayerState's default rather than an explicit value.
  const state = createLayerState({
    mode: 'single',
    bands: [1],
    colormap: 'viridis',
    ...(reversed === undefined ? {} : { reversed }),
  });
  const renderTile = buildSingleCompositeRenderTile(state, {} as Texture, null);
  const { renderPipeline } = renderTile(fakeTile());
  return renderPipeline.find((mod) => mod.module === Colormap)?.props as
    | Record<string, unknown>
    | undefined;
}

describe('single-band colormap reversed', () => {
  it('passes reversed: false by default', () => {
    expect(colormapProps()?.reversed).toBe(false);
  });

  it('passes reversed: true through to the Colormap module', () => {
    expect(colormapProps(true)?.reversed).toBe(true);
  });
});

describe('index (normalized-difference) render pipeline', () => {
  const runIndex = (overrides: Parameters<typeof createLayerState>[0]) => {
    const state = createLayerState({ mode: 'index', bands: [4, 3], ...overrides });
    const renderTile = buildIndexCompositeRenderTile(state, {} as Texture);
    return renderTile(fakeMultiBandTile(4)).renderPipeline;
  };

  it('assembles NormalizedDifference before rescale and a final Colormap', () => {
    const pipeline = runIndex({ colormap: 'rdylgn' });
    const modules = pipeline.map((m) => m.module);
    const ndIdx = modules.indexOf(NormalizedDifference);
    const rescaleIdx = modules.indexOf(PerBandLinearRescale);
    const cmapIdx = modules.indexOf(Colormap);
    expect(ndIdx).toBeGreaterThanOrEqual(0);
    // difference must be computed before the rescale that maps it into [0, 1]
    expect(ndIdx).toBeLessThan(rescaleIdx);
    expect(rescaleIdx).toBeLessThan(cmapIdx);
  });

  it('rescales the default [-1, 1] window without dividing by sampleScale', () => {
    const rescale = runIndex({ colormap: 'rdylgn', rescale: null }).find(
      (m) => m.module === PerBandLinearRescale,
    )?.props as { rescaleMin: number[]; rescaleMax: number[] };
    // sampleScale is 255, but the index is scale-invariant so the window is
    // passed through verbatim (unlike the single/RGB paths).
    expect(rescale.rescaleMin[0]).toBe(DEFAULT_INDEX_RANGE[0]);
    expect(rescale.rescaleMax[0]).toBe(DEFAULT_INDEX_RANGE[1]);
  });

  it('honours an explicit rescale override', () => {
    const rescale = runIndex({ rescale: [[0, 0.8]] }).find(
      (m) => m.module === PerBandLinearRescale,
    )?.props as { rescaleMin: number[]; rescaleMax: number[] };
    expect(rescale.rescaleMin[0]).toBe(0);
    expect(rescale.rescaleMax[0]).toBe(0.8);
  });

  it('maps operand A to red and operand B to green', () => {
    const composite = runIndex({}).find(
      (m) => m.module.name === 'compositeBands',
    )?.props as { channelMap: number[]; band0: unknown; band1: unknown };
    // channelMap[r]=slot0, channelMap[g]=slot1 for the two distinct bands.
    expect(composite.channelMap[0]).toBe(0);
    expect(composite.channelMap[1]).toBe(1);
  });

  it('selects the colormap named in state', () => {
    const cmap = runIndex({ colormap: 'viridis' }).find(
      (m) => m.module === Colormap,
    )?.props as { colormapIndex: number };
    expect(cmap.colormapIndex).toBe(COLORMAP_INDEX.viridis);
  });

  it('returns an empty pipeline when no bands are present', () => {
    const state = createLayerState({ mode: 'index', bands: [4, 3] });
    const renderTile = buildIndexCompositeRenderTile(state, {} as Texture);
    expect(renderTile(fakeMultiBandTile(0)).renderPipeline).toEqual([]);
  });
});
