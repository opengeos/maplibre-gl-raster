import maplibregl from 'maplibre-gl';
import { RasterControl } from '../../src/index';
import '../../src/index.css';
import 'maplibre-gl/dist/maplibre-gl.css';

// Public Cloud Optimized GeoTIFFs offered as one-click samples in the panel's
// "Load sample data" dropdown (the URL input stays empty until one is picked).
const SAMPLE_COGS = [
  {
    label: 'Land cover',
    url: 'https://data.source.coop/giswqs/opengeos/nlcd_2021_land_cover_30m.tif',
    attribution: 'U.S. Geological Survey (USGS)',
  },
  {
    label: 'Elevation (DEM)',
    url: 'https://data.source.coop/giswqs/opengeos/dem.tif',
    attribution: 'U.S. Geological Survey (USGS)',
  },
  {
    label: 'Bathymetry (GEBCO)',
    url: 'https://data.source.coop/giswqs/gebco-bathymetry/gebco_2026/gebco_2026.tif',
    attribution: 'GEBCO Compilation Group (2026)',
  },
  {
    label: 'NAIP aerial imagery (mosaic VRT)',
    url: 'https://data.source.coop/giswqs/opengeos/naip_water_train.vrt',
    attribution: 'USDA National Agriculture Imagery Program (NAIP)',
  },
];

// Create map
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  center: [0, 0],
  zoom: 2,
});

// Add navigation controls to top-right
map.addControl(new maplibregl.NavigationControl(), 'top-right');

// Add fullscreen control to top-right (after navigation)
map.addControl(new maplibregl.FullscreenControl(), 'top-right');

// Add the raster control when the map loads
map.on('load', () => {
  // Set collapsed: true to start with just the 29x29 button
  const rasterControl = new RasterControl({
    collapsed: false,
    // Offer samples as an opt-in dropdown instead of prefilling the input.
    sampleData: SAMPLE_COGS,
    // Keep the panel open until the close button is clicked.
    closeOnOutsideClick: false,
  });

  // Add control to the map
  map.addControl(rasterControl, 'top-left');

  // Listen for raster layer events
  rasterControl.on('rasteradd', (event) => {
    console.log('Raster added:', event.layerId);
  });

  rasterControl.on('rasterchange', (event) => {
    console.log('Raster changed:', event.layerId);
  });

  rasterControl.on('rasterremove', (event) => {
    console.log('Raster removed:', event.layerId);
  });

  rasterControl.on('error', (event) => {
    console.error('Raster error:', event.error);
  });
});
