import { useEffect, useRef } from "react";
import { RasterControl } from "./RasterControl";
import type { RasterControlReactProps } from "./types";

/**
 * React wrapper component for RasterControl.
 *
 * This component manages the lifecycle of a RasterControl instance,
 * adding it to the map on mount and removing it on unmount.
 *
 * @example
 * ```tsx
 * import { RasterControlReact } from 'maplibre-gl-raster/react';
 *
 * function MyMap() {
 *   const [map, setMap] = useState<Map | null>(null);
 *
 *   return (
 *     <>
 *       <div ref={mapContainer} />
 *       {map && (
 *         <RasterControlReact
 *           map={map}
 *           collapsed={false}
 *           onReady={(control) => control.addRaster('https://example.com/cog.tif')}
 *         />
 *       )}
 *     </>
 *   );
 * }
 * ```
 *
 * @param props - Component props including map instance and control options
 * @returns null - This component renders nothing directly
 */
export function RasterControlReact({
  map,
  onStateChange,
  onReady,
  ...options
}: RasterControlReactProps): null {
  const controlRef = useRef<RasterControl | null>(null);

  useEffect(() => {
    if (!map) return;

    // Create the control instance
    const control = new RasterControl(options);
    controlRef.current = control;

    // Register state change handler if provided
    if (onStateChange) {
      control.on("statechange", (event) => {
        onStateChange(event.state);
      });
    }

    // Add control to map
    map.addControl(control, options.position || "top-right");

    // Hand the instance to the host for imperative calls (addRaster, etc.)
    onReady?.(control);

    // Cleanup on unmount
    return () => {
      if (map.hasControl(control)) {
        map.removeControl(control);
      }
      controlRef.current = null;
    };
  }, [map]);

  // Update options when they change
  useEffect(() => {
    if (controlRef.current) {
      // Handle collapsed state changes
      const currentState = controlRef.current.getState();
      if (
        options.collapsed !== undefined &&
        options.collapsed !== currentState.collapsed
      ) {
        if (options.collapsed) {
          controlRef.current.collapse();
        } else {
          controlRef.current.expand();
        }
      }
    }
  }, [options.collapsed]);

  return null;
}
