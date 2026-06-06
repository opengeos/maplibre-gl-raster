import {
  Compression,
  Photometric,
  PlanarConfiguration,
  Predictor,
  SampleFormat,
  TiffTag,
} from '@cogeotiff/core';
import { describe, expect, it } from 'vitest';
import {
  compressionLabel,
  crsLabel,
  dtypeLabel,
  filterUserGdalItems,
  parseGdalItems,
  photometricLabel,
  predictorLabel,
  prettyPrintGdalXml,
  summarizeGeoTIFF,
} from '../src/lib/raster/metadata';

const SAMPLE_GDAL_XML = `<GDALMetadata>
  <Item name="AREA_OR_POINT">Area</Item>
  <Item name="TIFFTAG_DATETIME">2024:01:02 03:04:05</Item>
  <Item name="DESCRIPTION" sample="0">Red surface reflectance</Item>
  <Item name="STATISTICS_MINIMUM" sample="0">0</Item>
  <Item name="STATISTICS_MAXIMUM" sample="0">10000</Item>
  <Item name="STATISTICS_MEAN" sample="0">1234.5</Item>
  <Item name="STATISTICS_STDDEV" sample="0">456.7</Item>
  <Item name="STATISTICS_VALID_PERCENT" sample="0">99.8</Item>
  <Item name="DESCRIPTION" sample="1">NIR surface reflectance</Item>
  <Item name="SCALE_TYPE" sample="0" role="description">reflectance</Item>
</GDALMetadata>`;

describe('parseGdalItems', () => {
  it('parses items with name/value/sample/role', () => {
    const items = parseGdalItems(SAMPLE_GDAL_XML);
    expect(items.length).toBeGreaterThanOrEqual(9);
    const areaOrPoint = items.find((it) => it.name === 'AREA_OR_POINT');
    expect(areaOrPoint).toMatchObject({
      value: 'Area',
      sample: null,
      role: null,
    });
    // Sample is normalized 0-based → 1-based.
    const red = items.find(
      (it) => it.name === 'DESCRIPTION' && it.value === 'Red surface reflectance',
    );
    expect(red?.sample).toBe(1);
    // role attribute preserved.
    const role = items.find((it) => it.name === 'SCALE_TYPE');
    expect(role?.role).toBe('description');
  });

  it('returns [] on missing / empty / malformed input', () => {
    expect(parseGdalItems(null)).toEqual([]);
    expect(parseGdalItems(undefined)).toEqual([]);
    expect(parseGdalItems('')).toEqual([]);
    expect(parseGdalItems('not xml at all <<<')).toEqual([]);
  });

  it('ignores items without a name attribute', () => {
    const items = parseGdalItems(
      `<GDALMetadata><Item>no name</Item><Item name="OK">v</Item></GDALMetadata>`,
    );
    expect(items.map((it) => it.name)).toEqual(['OK']);
  });
});

describe('filterUserGdalItems', () => {
  it('drops band-level STATISTICS_*, DESCRIPTION, BAND_NAME entries', () => {
    const items = parseGdalItems(SAMPLE_GDAL_XML);
    const filtered = filterUserGdalItems(items);
    const names = filtered.map((it) => it.name);
    // Dataset-level items stay.
    expect(names).toContain('AREA_OR_POINT');
    expect(names).toContain('TIFFTAG_DATETIME');
    // Band-level reserved names dropped.
    expect(names).not.toContain('STATISTICS_MINIMUM');
    expect(names).not.toContain('DESCRIPTION');
    // Non-reserved band-level items stay (SCALE_TYPE is custom).
    expect(names).toContain('SCALE_TYPE');
  });

  it('keeps dataset-level items whose name happens to overlap a band-only reserved name', () => {
    // Hypothetical: a DESCRIPTION at the dataset level (no sample) shouldn't
    // be dropped — only sample-scoped ones are.
    const items = parseGdalItems(
      `<GDALMetadata><Item name="DESCRIPTION">dataset summary</Item></GDALMetadata>`,
    );
    expect(filterUserGdalItems(items)).toHaveLength(1);
  });
});

describe('prettyPrintGdalXml', () => {
  it('indents nested elements two spaces', () => {
    const out = prettyPrintGdalXml(SAMPLE_GDAL_XML);
    expect(out.split('\n')[0]).toBe('<GDALMetadata>');
    // First indented line uses two spaces.
    expect(out.split('\n')[1].startsWith('  <Item')).toBe(true);
  });

  it('returns the input verbatim on malformed XML', () => {
    expect(prettyPrintGdalXml('not xml')).toBe('not xml');
  });
});

describe('label helpers', () => {
  it('compressionLabel maps known codes and falls back for unknown', () => {
    expect(compressionLabel(Compression.Deflate)).toBe('Deflate');
    expect(compressionLabel(Compression.Lzw)).toBe('LZW');
    expect(compressionLabel(99999)).toBe('unknown (99999)');
    expect(compressionLabel(null)).toBe('unknown');
  });

  it('photometricLabel maps known codes', () => {
    expect(photometricLabel(Photometric.Rgb)).toBe('RGB');
    expect(photometricLabel(Photometric.MinIsBlack)).toBe('min-is-black');
  });

  it('dtypeLabel joins format and bits', () => {
    expect(dtypeLabel(SampleFormat.Uint, 8)).toBe('uint8');
    expect(dtypeLabel(SampleFormat.Float, 32)).toBe('float32');
    expect(dtypeLabel(SampleFormat.Int, 16)).toBe('int16');
    expect(dtypeLabel(null, 8)).toBe('unknown8');
  });

  it('predictorLabel collapses None → null', () => {
    expect(predictorLabel(Predictor.None)).toBeNull();
    expect(predictorLabel(Predictor.Horizontal)).toBe('horizontal');
    expect(predictorLabel(Predictor.FloatingPoint)).toBe('floating-point');
  });
});

describe('crsLabel', () => {
  it('formats an EPSG number', () => {
    expect(crsLabel(3857)).toEqual({ code: 3857, label: 'EPSG:3857' });
  });
  it('formats a PROJJSON-like object', () => {
    expect(crsLabel({ name: 'Custom WGS84 variant' })).toEqual({
      code: null,
      label: 'User-defined: Custom WGS84 variant',
    });
  });
  it('falls back to unknown for missing input', () => {
    expect(crsLabel(null).label).toBe('unknown');
  });
});

/**
 * Minimal fake of the GeoTIFF surface that `summarizeGeoTIFF` reads.
 * Cast through `unknown` to the parameter type — keeps the test focused
 * on the contract, not the full class.
 */
function makeFakeGeoTIFF(opts: {
  gdalXml?: string | null;
  count?: number;
  overviews?: number;
  crs?: number | { name: string };
  citation?: string | null;
}) {
  const gdalXml = opts.gdalXml ?? null;
  const overviewCount = opts.overviews ?? 0;
  const overviews = Array.from({ length: overviewCount }, (_, i) => ({
    width: 512 >> i,
    height: 512 >> i,
    tileWidth: 256,
    tileHeight: 256,
    tileCount: { x: 2 >> i || 1, y: 2 >> i || 1 },
  }));
  return {
    image: {
      value: (tag: number) =>
        tag === TiffTag.GdalMetadata ? (gdalXml ?? undefined) : undefined,
    },
    width: 1024,
    height: 1024,
    count: opts.count ?? 3,
    tileWidth: 256,
    tileHeight: 256,
    nodata: -9999,
    crs: opts.crs ?? 3857,
    bbox: [-180, -85, 180, 85] as [number, number, number, number],
    cachedTags: {
      compression: Compression.Deflate,
      photometric: Photometric.Rgb,
      bitsPerSample: new Uint16Array([16, 16, 16]),
      sampleFormat: [SampleFormat.Uint, SampleFormat.Uint, SampleFormat.Uint],
      predictor: Predictor.Horizontal,
      planarConfiguration: PlanarConfiguration.Contig,
      modelPixelScale: [10, 10, 0],
    },
    gkd: {
      citation: opts.citation ?? null,
      projectedCitation: null,
      geodeticCitation: null,
    },
    offsets: [0, 0, 0],
    scales: [1, 1, 1],
    storedStats: null,
    overviews,
  } as unknown as Parameters<typeof summarizeGeoTIFF>[0];
}

describe('summarizeGeoTIFF', () => {
  it('handles a COG with no GDAL_METADATA', () => {
    const summary = summarizeGeoTIFF(makeFakeGeoTIFF({ gdalXml: null }));
    expect(summary.rawGdalXml).toBeNull();
    expect(summary.gdalItems).toEqual([]);
    // Band names null when no DESCRIPTION items.
    expect(summary.bands.every((b) => b.name === null)).toBe(true);
    // Image fields still populated from cached tags.
    expect(summary.image.dtype).toBe('uint16');
    expect(summary.image.compression).toBe('Deflate');
    expect(summary.image.predictor).toBe('horizontal');
  });

  it('surfaces per-band stats and names from GDAL_METADATA', () => {
    const summary = summarizeGeoTIFF(
      makeFakeGeoTIFF({ gdalXml: SAMPLE_GDAL_XML, count: 2 }),
    );
    expect(summary.bands[0].name).toBe('Red surface reflectance');
    expect(summary.bands[0].stats).toEqual({
      min: 0,
      max: 10000,
      mean: 1234.5,
      std: 456.7,
      validPercent: 99.8,
    });
    expect(summary.bands[1].name).toBe('NIR surface reflectance');
    expect(summary.bands[1].stats).toBeNull(); // sample=1 has no STATISTICS_*
  });

  it('excludes band-only reserved items from gdalItems but keeps custom ones', () => {
    const summary = summarizeGeoTIFF(
      makeFakeGeoTIFF({ gdalXml: SAMPLE_GDAL_XML, count: 2 }),
    );
    const names = summary.gdalItems.map((it) => it.name);
    expect(names).toContain('AREA_OR_POINT');
    expect(names).toContain('SCALE_TYPE'); // band-level but not reserved
    expect(names).not.toContain('STATISTICS_MINIMUM');
  });

  it('labels user-defined CRSes with the PROJJSON name', () => {
    const summary = summarizeGeoTIFF(
      makeFakeGeoTIFF({ crs: { name: 'Custom Lambert' } }),
    );
    expect(summary.crs.code).toBeNull();
    expect(summary.crs.label).toBe('User-defined: Custom Lambert');
  });

  it('returns an empty overviews list when none are present', () => {
    const summary = summarizeGeoTIFF(makeFakeGeoTIFF({ overviews: 0 }));
    expect(summary.overviews).toEqual([]);
  });

  it('includes overviews with width/height/tile info', () => {
    const summary = summarizeGeoTIFF(makeFakeGeoTIFF({ overviews: 2 }));
    expect(summary.overviews).toHaveLength(2);
    expect(summary.overviews[0]).toMatchObject({
      width: 512,
      height: 512,
      tileWidth: 256,
      tileHeight: 256,
    });
  });
});
