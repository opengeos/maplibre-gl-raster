import { describe, expect, it } from 'vitest';
import { Colormap } from '@developmentseed/deck.gl-raster/gpu-modules';
import type { Texture } from '@luma.gl/core';
import { buildSingleCompositeRenderTile } from '../src/lib/raster/render-pipeline';
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

function colormapProps(reversed: boolean): Record<string, unknown> | undefined {
  const state = createLayerState({
    mode: 'single',
    bands: [1],
    colormap: 'viridis',
    reversed,
  });
  const renderTile = buildSingleCompositeRenderTile(state, {} as Texture, null);
  const { renderPipeline } = renderTile(fakeTile());
  return renderPipeline.find((mod) => mod.module === Colormap)?.props as
    | Record<string, unknown>
    | undefined;
}

describe('single-band colormap reversed', () => {
  it('passes reversed: false by default', () => {
    expect(colormapProps(false)?.reversed).toBe(false);
  });

  it('passes reversed: true through to the Colormap module', () => {
    expect(colormapProps(true)?.reversed).toBe(true);
  });
});
