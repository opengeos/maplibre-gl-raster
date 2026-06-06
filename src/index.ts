// Import styles
import './lib/styles/raster-control.css';

// Main entry point - Core exports
export { RasterControl } from './lib/core/RasterControl';

// Raster utilities for advanced use
export { loadGeoTIFF } from './lib/raster/load-geotiff';
export { summarizeGeoTIFF } from './lib/raster/metadata';
export {
  computeAutoStats,
  percentileFromHistogram,
  readBandNames,
} from './lib/raster/stats';
export {
  COLORMAP_NAMES,
  COLORMAP_OPTIONS,
  colormapsPngUrl,
} from './lib/raster/colormaps';

// Type exports
export type {
  AddRasterOptions,
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
export type { MetadataSummary } from './lib/raster/metadata';
export type { AutoStats, BandStats } from './lib/raster/stats';

// Utility exports
export {
  clamp,
  formatNumericValue,
  generateId,
  debounce,
  throttle,
  classNames,
} from './lib/utils';
