// Import styles
import './lib/styles/raster-control.css';

// Main entry point - Core exports
export { RasterControl } from './lib/core/RasterControl';
export { Colorbar } from './lib/core/Colorbar';

// Headless rendering core. `RasterControl` is a thin UI wrapper around this
// class; consume `LayerManager` directly to drive COG rendering from your own
// UI (add/remove/show/restyle raster layers and listen for lifecycle events)
// without mounting the built-in panel.
export { LayerManager, DEFAULT_ENGINE } from './lib/state/LayerManager';
export type {
  LayerManagerEvent,
  LayerManagerEventData,
  LayerManagerEventHandler,
  LayerManagerDeps,
  OverlayLike,
} from './lib/state/LayerManager';
export type { RasterLayer } from './lib/state/RasterLayer';

// Raster utilities for advanced use
export { loadGeoTIFF } from './lib/raster/load-geotiff';
export {
  isVrtFile,
  isVrtUrl,
  loadVrt,
  parseVrt,
  VrtUnsupportedError,
} from './lib/raster/vrt';
export type { VrtMember, VrtMosaic } from './lib/raster/vrt';
export {
  isKnownColormap,
  loadColormapSprite,
  sampleColormapStops,
} from './lib/raster/colormap-sampler';
export {
  autoRangeFor,
  DEFAULT_INDEX_RANGE,
  statsForBand,
} from './lib/raster/render-pipeline';
export {
  CUSTOM_INDEX_ID,
  CUSTOM_NORMALIZED_DIFFERENCE,
  guessBandForRole,
  indexById,
  NORMALIZED_DIFFERENCE_INDICES,
} from './lib/raster/indices';
export type { NormalizedDifferenceIndex } from './lib/raster/indices';
export { readPixelValues } from './lib/raster/inspect';
export { createResilientEpsgResolver } from './lib/raster/epsg-resolver';
export { summarizeGeoTIFF } from './lib/raster/metadata';
export {
  computeAutoStats,
  MAX_SAMPLE_TILES,
  percentileFromHistogram,
  readBandNames,
} from './lib/raster/stats';
export {
  COLORMAP_DISPLAY_NAMES,
  COLORMAP_NAMES,
  COLORMAP_OPTIONS,
  COLORMAP_ROW_COUNT,
  colormapDisplayName,
  colormapsPngUrl,
} from './lib/raster/colormaps';
export { PALETTE_COLORMAP } from './lib/ui/ColormapPicker';

// Type exports
export type {
  ColorbarOptions,
  ColorbarOrientation,
  ColorbarStretch,
} from './lib/core/Colorbar';
export type {
  AddRasterOptions,
  GeographicBounds,
  RasterControlEvent,
  RasterControlEventData,
  RasterControlEventHandler,
  RasterControlOptions,
  RasterControlState,
  RasterSampleDataset,
  RasterLayerInfo,
  RasterLayerSource,
  RasterLayerState,
  RasterMode,
  RasterNodata,
  RasterStretch,
  RenderEngine,
} from './lib/core/types';
export type {
  BandSummary,
  CrsSummary,
  GdalItem,
  ImageSummary,
  MetadataSummary,
  OverviewSummary,
} from './lib/raster/metadata';
export type { AutoStats, BandStats } from './lib/raster/stats';
export type { BandReading, PixelReading } from './lib/raster/inspect';
export type { ColormapOption } from './lib/raster/colormaps';
export type { ResilientEpsgResolverOptions } from './lib/raster/epsg-resolver';
export type { EpsgResolver } from '@developmentseed/proj';

// Utility exports
export {
  clamp,
  formatNumericValue,
  generateId,
  debounce,
  throttle,
  classNames,
} from './lib/utils';
