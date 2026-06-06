// Import styles
import './lib/styles/raster-control.css';

// Main entry point - Core exports
export { RasterControl } from './lib/core/RasterControl';

// Type exports
export type {
  RasterControlOptions,
  RasterControlState,
  RasterControlEvent,
  RasterControlEventHandler,
} from './lib/core/types';

// Utility exports
export {
  clamp,
  formatNumericValue,
  generateId,
  debounce,
  throttle,
  classNames,
} from './lib/utils';
