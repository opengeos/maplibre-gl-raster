// React entry point
export { RasterControlReact } from './lib/core/RasterControlReact';
export { RasterControl } from './lib/core/RasterControl';

// React hooks
export { useRasterState } from './lib/hooks';

// Re-export types for React consumers
export type {
  AddRasterOptions,
  RasterControlEvent,
  RasterControlEventData,
  RasterControlEventHandler,
  RasterControlOptions,
  RasterControlReactProps,
  RasterControlState,
  RasterLayerInfo,
  RasterLayerSource,
  RasterLayerState,
  RasterMode,
  RasterNodata,
  RasterStretch,
} from './lib/core/types';
