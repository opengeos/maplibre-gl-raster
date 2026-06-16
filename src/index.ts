// Import styles
import './lib/styles/raster-control.css';

// Main entry point - Core exports
export { RasterControl } from './lib/core/RasterControl';
export { Colorbar } from './lib/core/Colorbar';

// Raster utilities for advanced use
export { loadGeoTIFF } from './lib/raster/load-geotiff';
export {
  isKnownColormap,
  loadColormapSprite,
  sampleColormapStops,
} from './lib/raster/colormap-sampler';
export { autoRangeFor, statsForBand } from './lib/raster/render-pipeline';
export { createResilientEpsgResolver } from './lib/raster/epsg-resolver';
export { summarizeGeoTIFF } from './lib/raster/metadata';
export {
  computeAutoStats,
  MAX_SAMPLE_TILES,
  percentileFromHistogram,
  readBandNames,
} from './lib/raster/stats';
export {
  COLORMAP_NAMES,
  COLORMAP_OPTIONS,
  COLORMAP_ROW_COUNT,
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
  RasterLayerInfo,
  RasterLayerSource,
  RasterLayerState,
  RasterMode,
  RasterNodata,
  RasterStretch,
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
