import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import maplibregl, { Map } from 'maplibre-gl';
import { RasterControlReact, useRasterState } from '../../src/react';
import '../../src/index.css';
import 'maplibre-gl/dist/maplibre-gl.css';

// A public Cloud Optimized GeoTIFF prefilled in the Add data input
// (not loaded until the user clicks Load).
const DEMO_COG = 'https://data.source.coop/giswqs/opengeos/nlcd_2021_land_cover_30m.tif';

/**
 * Main App component demonstrating the React integration
 */
function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<Map | null>(null);
  const { state, setState, toggle } = useRasterState({ collapsed: false });

  // Initialize the map
  useEffect(() => {
    if (!mapContainer.current) return;

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [0, 0],
      zoom: 2,
    });

    // Add navigation controls to top-right
    mapInstance.addControl(new maplibregl.NavigationControl(), 'top-right');

    // Add fullscreen control to top-right (after navigation)
    mapInstance.addControl(new maplibregl.FullscreenControl(), 'top-right');

    mapInstance.on('load', () => {
      setMap(mapInstance);
    });

    return () => {
      mapInstance.remove();
    };
  }, []);

  // Mirror control-driven changes (e.g. the panel's own close button) into
  // local state so the external toggle button label stays in sync.
  const handleStateChange = (newState: typeof state) => {
    console.log('Control state changed:', newState);
    setState(newState);
  };

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      {/* External toggle button */}
      <button
        onClick={toggle}
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          zIndex: 1,
          padding: '8px 16px',
          background: '#4a90d9',
          color: 'white',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          fontWeight: 500,
        }}
      >
        {state.collapsed ? 'Expand' : 'Collapse'} Panel
      </button>

      {/* Raster control */}
      {map && (
        <RasterControlReact
          map={map}
          collapsed={state.collapsed}
          panelWidth={360}
          defaultUrl={DEMO_COG}
          onStateChange={handleStateChange}
        />
      )}
    </div>
  );
}

// Mount the app
const root = createRoot(document.getElementById('root')!);
root.render(<App />);
