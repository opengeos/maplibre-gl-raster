// React entry point
export { RasterControlReact } from './lib/core/RasterControlReact';

// React hooks
export { useRasterState } from './lib/hooks';

// Re-export types for React consumers
export type {
  RasterControlOptions,
  RasterControlState,
  RasterControlReactProps,
  RasterControlEvent,
  RasterControlEventHandler,
} from './lib/core/types';
