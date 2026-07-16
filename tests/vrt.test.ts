import { describe, expect, it } from 'vitest';
import {
  VrtUnsupportedError,
  isVrtFile,
  isVrtUrl,
  parseVrt,
} from '../src/lib/raster/vrt';

const VRT_URL = 'https://example.com/data/mosaic.vrt';

/** A two-source, single-band mosaic in the shape gdalbuildvrt emits. */
function mosaicVrt(sources: string): string {
  return `<VRTDataset rasterXSize="2000" rasterYSize="1000">
  <SRS>EPSG:4326</SRS>
  <GeoTransform>-180.0, 0.18, 0.0, 90.0, 0.0, -0.18</GeoTransform>
  <VRTRasterBand dataType="Byte" band="1">
    <NoDataValue>0</NoDataValue>
    ${sources}
  </VRTRasterBand>
</VRTDataset>`;
}

function simpleSource(
  filename: string,
  opts: { xOff?: number; size?: number; dstSize?: number } = {},
): string {
  const { xOff = 0, size = 1000, dstSize = size } = opts;
  return `<SimpleSource>
      <SourceFilename relativeToVRT="1">${filename}</SourceFilename>
      <SourceBand>1</SourceBand>
      <SourceProperties RasterXSize="1000" RasterYSize="1000" DataType="Byte" BlockXSize="512" BlockYSize="512"/>
      <SrcRect xOff="0" yOff="0" xSize="${size}" ySize="${size}"/>
      <DstRect xOff="${xOff}" yOff="0" xSize="${dstSize}" ySize="${dstSize}"/>
    </SimpleSource>`;
}

describe('isVrtUrl / isVrtFile', () => {
  it('matches .vrt paths regardless of case and query string', () => {
    expect(isVrtUrl('https://example.com/a/mosaic.vrt')).toBe(true);
    expect(isVrtUrl('https://example.com/a/MOSAIC.VRT')).toBe(true);
    expect(isVrtUrl('https://example.com/a/mosaic.vrt?token=abc')).toBe(true);
    expect(isVrtUrl('mosaic.vrt')).toBe(true);
  });

  it('strips query strings and fragments from relative URLs too', () => {
    // A relative URL has no scheme to key off, and a fragment is not a query.
    expect(isVrtUrl('/data/mosaic.vrt?token=x')).toBe(true);
    expect(isVrtUrl('mosaic.vrt#section')).toBe(true);
    expect(isVrtUrl('https://example.com/a/mosaic.vrt#s')).toBe(true);
    expect(isVrtUrl('https://example.com/a/mosaic.vrt?t=1#s')).toBe(true);
    expect(isVrtUrl('/data/cog.tif?name=x.vrt')).toBe(false);
  });

  it('does not match other rasters', () => {
    expect(isVrtUrl('https://example.com/a/cog.tif')).toBe(false);
    // A .tif with "vrt" elsewhere in the path must not be misread.
    expect(isVrtUrl('https://example.com/vrt/cog.tif')).toBe(false);
    expect(isVrtFile({ name: 'mosaic.vrt' })).toBe(true);
    expect(isVrtFile({ name: 'cog.tif' })).toBe(false);
  });
});

describe('parseVrt', () => {
  it('parses a plain two-source mosaic', () => {
    const vrt = mosaicVrt(
      simpleSource('tile_a.tif') + simpleSource('tile_b.tif', { xOff: 1000 }),
    );
    const mosaic = parseVrt(vrt, VRT_URL);

    expect(mosaic.bandCount).toBe(1);
    expect(mosaic.nodata).toBe(0);
    expect(mosaic.members.map((m) => m.url)).toEqual([
      'https://example.com/data/tile_a.tif',
      'https://example.com/data/tile_b.tif',
    ]);
    expect(mosaic.members[1].dst).toEqual({
      xOff: 1000,
      yOff: 0,
      xSize: 1000,
      ySize: 1000,
    });
  });

  it('resolves relative paths against the VRT, not the origin root', () => {
    const mosaic = parseVrt(mosaicVrt(simpleSource('sub/tile.tif')), VRT_URL);
    expect(mosaic.members[0].url).toBe(
      'https://example.com/data/sub/tile.tif',
    );
  });

  it('accepts absolute https sources and strips a /vsicurl/ prefix', () => {
    const mosaic = parseVrt(
      mosaicVrt(
        simpleSource('https://other.org/a.tif') +
          simpleSource('/vsicurl/https://other.org/b.tif', { xOff: 1000 }),
      ),
      VRT_URL,
    );
    expect(mosaic.members.map((m) => m.url)).toEqual([
      'https://other.org/a.tif',
      'https://other.org/b.tif',
    ]);
  });

  it('accepts a ComplexSource that only declares NODATA, and carries the value', () => {
    // What gdalbuildvrt -srcnodata emits; equivalent to a SimpleSource plus a
    // nodata declaration.
    const vrt = mosaicVrt(`<ComplexSource>
      <SourceFilename relativeToVRT="1">tile_a.tif</SourceFilename>
      <SourceBand>1</SourceBand>
      <SrcRect xOff="0" yOff="0" xSize="1000" ySize="1000"/>
      <DstRect xOff="0" yOff="0" xSize="1000" ySize="1000"/>
      <NODATA>255</NODATA>
    </ComplexSource>`);
    const mosaic = parseVrt(vrt, VRT_URL);
    expect(mosaic.members).toHaveLength(1);
    // The source's NODATA describes the member's own pixels — which is what
    // gets drawn — so it wins over the band's <NoDataValue> of 0.
    expect(mosaic.nodata).toBe(255);
  });

  it('carries a source NODATA when the band declares none', () => {
    const vrt = `<VRTDataset rasterXSize="10" rasterYSize="10">
      <VRTRasterBand dataType="Byte" band="1">
        <ComplexSource>
          <SourceFilename relativeToVRT="1">a.tif</SourceFilename>
          <NODATA>-9999</NODATA>
        </ComplexSource>
      </VRTRasterBand>
    </VRTDataset>`;
    expect(parseVrt(vrt, VRT_URL).nodata).toBe(-9999);
  });

  it('falls back to the band NoDataValue when no source declares one', () => {
    expect(parseVrt(mosaicVrt(simpleSource('a.tif')), VRT_URL).nodata).toBe(0);
  });

  it('accepts sources with no SrcRect/DstRect (whole-file placement)', () => {
    const vrt = mosaicVrt(`<SimpleSource>
      <SourceFilename relativeToVRT="1">tile_a.tif</SourceFilename>
      <SourceBand>1</SourceBand>
    </SimpleSource>`);
    expect(parseVrt(vrt, VRT_URL).members[0].url).toBe(
      'https://example.com/data/tile_a.tif',
    );
  });

  it('reads multi-band mosaics that share one member list', () => {
    const band = (n: number) => `<VRTRasterBand dataType="Byte" band="${n}">
      <SimpleSource>
        <SourceFilename relativeToVRT="1">rgb.tif</SourceFilename>
        <SourceBand>${n}</SourceBand>
      </SimpleSource>
    </VRTRasterBand>`;
    const vrt = `<VRTDataset rasterXSize="10" rasterYSize="10">${band(1)}${band(2)}${band(3)}</VRTDataset>`;
    const mosaic = parseVrt(vrt, VRT_URL);
    expect(mosaic.bandCount).toBe(3);
    expect(mosaic.members).toHaveLength(1);
    expect(mosaic.nodata).toBeNull();
  });

  it('ignores non-finite NoDataValue spellings', () => {
    const vrt = mosaicVrt(simpleSource('a.tif')).replace(
      '<NoDataValue>0</NoDataValue>',
      '<NoDataValue>nan</NoDataValue>',
    );
    expect(parseVrt(vrt, VRT_URL).nodata).toBeNull();
  });
});

describe('parseVrt on real gdalbuildvrt output', () => {
  // Verbatim output of `gdalbuildvrt mosaic.vrt tile_a.tif tile_b.tif` against
  // two adjacent single-band EPSG:4326 COGs (GDAL 3.12.2). Pinned so the parser
  // cannot drift from the shape GDAL actually emits.
  const REAL_VRT = `<VRTDataset rasterXSize="1024" rasterYSize="512">
  <SRS dataAxisToSRSAxisMapping="2,1">GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AXIS["Latitude",NORTH],AXIS["Longitude",EAST],AUTHORITY["EPSG","4326"]]</SRS>
  <GeoTransform> -1.0000000000000000e+01,  1.9531250000000000e-02,  0.0000000000000000e+00,  1.0000000000000000e+01,  0.0000000000000000e+00, -1.9531250000000000e-02</GeoTransform>
  <VRTRasterBand dataType="Byte" band="1">
    <ColorInterp>Gray</ColorInterp>
    <SimpleSource>
      <SourceFilename relativeToVRT="1">tile_a.tif</SourceFilename>
      <SourceBand>1</SourceBand>
      <SourceProperties RasterXSize="512" RasterYSize="512" DataType="Byte" BlockXSize="512" BlockYSize="512" />
      <SrcRect xOff="0" yOff="0" xSize="512" ySize="512" />
      <DstRect xOff="0" yOff="0" xSize="512" ySize="512" />
    </SimpleSource>
    <SimpleSource>
      <SourceFilename relativeToVRT="1">tile_b.tif</SourceFilename>
      <SourceBand>1</SourceBand>
      <SourceProperties RasterXSize="512" RasterYSize="512" DataType="Byte" BlockXSize="512" BlockYSize="512" />
      <SrcRect xOff="0" yOff="0" xSize="512" ySize="512" />
      <DstRect xOff="512" yOff="0" xSize="512" ySize="512" />
    </SimpleSource>
  </VRTRasterBand>
</VRTDataset>`;

  it('accepts it and resolves both members', () => {
    const mosaic = parseVrt(REAL_VRT, VRT_URL);
    expect(mosaic.bandCount).toBe(1);
    expect(mosaic.nodata).toBeNull();
    expect(mosaic.members.map((m) => m.url)).toEqual([
      'https://example.com/data/tile_a.tif',
      'https://example.com/data/tile_b.tif',
    ]);
    expect(mosaic.members[1].dst).toEqual({
      xOff: 512,
      yOff: 0,
      xSize: 512,
      ySize: 512,
    });
  });

  it('rejects the <UseMaskBand> GDAL emits for sources with a mask band', () => {
    // Verbatim output of `gdalbuildvrt mask.vrt masked_a.tif` where the source
    // carries an internal mask band (GDAL 3.12.2). GDAL applies that mask while
    // compositing; drawn on its own, the masked-out pixels would render as data.
    const MASKED_VRT = `<VRTDataset rasterXSize="512" rasterYSize="512">
  <GeoTransform> -1.0000000000000000e+01,  1.9531250000000000e-02,  0.0000000000000000e+00,  1.0000000000000000e+01,  0.0000000000000000e+00, -1.9531250000000000e-02</GeoTransform>
  <VRTRasterBand dataType="Byte" band="1">
    <ColorInterp>Gray</ColorInterp>
    <ComplexSource>
      <SourceFilename relativeToVRT="1">masked_a.tif</SourceFilename>
      <SourceBand>1</SourceBand>
      <SourceProperties RasterXSize="512" RasterYSize="512" DataType="Byte" BlockXSize="256" BlockYSize="256" />
      <SrcRect xOff="0" yOff="0" xSize="512" ySize="512" />
      <DstRect xOff="0" yOff="0" xSize="512" ySize="512" />
      <UseMaskBand>true</UseMaskBand>
    </ComplexSource>
  </VRTRasterBand>
</VRTDataset>`;
    expect(() => parseVrt(MASKED_VRT, VRT_URL)).toThrow(VrtUnsupportedError);
    expect(() => parseVrt(MASKED_VRT, VRT_URL)).toThrow(
      /masks its sources through their mask bands/,
    );
  });

  it('carries the NODATA gdalbuildvrt -srcnodata writes on each source', () => {
    // Verbatim shape of `gdalbuildvrt -srcnodata 0 …`: a band <NoDataValue>
    // plus a per-source <NODATA>, which GDAL keeps in sync.
    const SRCNODATA_VRT = `<VRTDataset rasterXSize="1024" rasterYSize="512">
  <VRTRasterBand dataType="Byte" band="1">
    <NoDataValue>0</NoDataValue>
    <ColorInterp>Gray</ColorInterp>
    <ComplexSource>
      <SourceFilename relativeToVRT="1">tile_a.tif</SourceFilename>
      <SourceBand>1</SourceBand>
      <SourceProperties RasterXSize="512" RasterYSize="512" DataType="Byte" BlockXSize="512" BlockYSize="512" />
      <SrcRect xOff="0" yOff="0" xSize="512" ySize="512" />
      <DstRect xOff="0" yOff="0" xSize="512" ySize="512" />
      <NODATA>0</NODATA>
    </ComplexSource>
    <ComplexSource>
      <SourceFilename relativeToVRT="1">tile_b.tif</SourceFilename>
      <SourceBand>1</SourceBand>
      <SourceProperties RasterXSize="512" RasterYSize="512" DataType="Byte" BlockXSize="512" BlockYSize="512" />
      <SrcRect xOff="0" yOff="0" xSize="512" ySize="512" />
      <DstRect xOff="512" yOff="0" xSize="512" ySize="512" />
      <NODATA>0</NODATA>
    </ComplexSource>
  </VRTRasterBand>
</VRTDataset>`;
    const mosaic = parseVrt(SRCNODATA_VRT, VRT_URL);
    expect(mosaic.members).toHaveLength(2);
    expect(mosaic.nodata).toBe(0);
  });
});

describe('parseVrt rejections', () => {
  const expectReject = (xml: string, match: RegExp, url = VRT_URL) => {
    expect(() => parseVrt(xml, url)).toThrow(VrtUnsupportedError);
    expect(() => parseVrt(xml, url)).toThrow(match);
  };

  it('rejects malformed XML', () => {
    expectReject('<VRTDataset><oops>', /not valid XML/);
  });

  it('rejects a non-VRT document', () => {
    expectReject('<kml><Document/></kml>', /does not look like a GDAL .vrt/);
  });

  it('rejects a warped VRT and names gdalwarp', () => {
    const vrt = mosaicVrt(simpleSource('a.tif')).replace(
      '<VRTDataset',
      '<VRTDataset subClass="VRTWarpedDataset"',
    );
    expectReject(vrt, /warped VRT/);
    expectReject(vrt, /gdalwarp/);
  });

  it('rejects a pansharpened VRT', () => {
    const vrt = mosaicVrt(simpleSource('a.tif')).replace(
      '<VRTDataset',
      '<VRTDataset subClass="VRTPansharpenedDataset"',
    );
    expectReject(vrt, /pansharpened/);
  });

  it('rejects a pixel-function band and names the function', () => {
    const vrt = `<VRTDataset rasterXSize="10" rasterYSize="10">
      <VRTRasterBand dataType="Float32" band="1" subClass="VRTDerivedRasterBand">
        <PixelFunctionType>sum</PixelFunctionType>
        <SimpleSource><SourceFilename relativeToVRT="1">a.tif</SourceFilename></SimpleSource>
      </VRTRasterBand>
    </VRTDataset>`;
    expectReject(vrt, /pixel function \("sum"\)/);
  });

  it('rejects value rescaling through ScaleRatio', () => {
    const vrt = mosaicVrt(`<ComplexSource>
      <SourceFilename relativeToVRT="1">a.tif</SourceFilename>
      <ScaleOffset>0</ScaleOffset>
      <ScaleRatio>0.0001</ScaleRatio>
    </ComplexSource>`);
    expectReject(vrt, /rescales its source through <ScaleOffset>/);
  });

  it('rejects a LUT', () => {
    const vrt = mosaicVrt(`<ComplexSource>
      <SourceFilename relativeToVRT="1">a.tif</SourceFilename>
      <LUT>0:0,255:255</LUT>
    </ComplexSource>`);
    expectReject(vrt, /<LUT>/);
  });

  it('rejects sources masked through a mask band', () => {
    // gdalbuildvrt emits <UseMaskBand> whenever a source carries an internal
    // mask band. Members are drawn on their own, so the mask would be lost and
    // masked-out pixels would render as data.
    const vrt = mosaicVrt(`<ComplexSource>
      <SourceFilename relativeToVRT="1">a.tif</SourceFilename>
      <SourceBand>1</SourceBand>
      <UseMaskBand>true</UseMaskBand>
    </ComplexSource>`);
    expectReject(vrt, /masks its sources through their mask bands/);
  });

  it('rejects sources that disagree on NODATA', () => {
    const source = (file: string, nodata: number) => `<ComplexSource>
      <SourceFilename relativeToVRT="1">${file}</SourceFilename>
      <SourceBand>1</SourceBand>
      <NODATA>${nodata}</NODATA>
    </ComplexSource>`;
    const vrt = mosaicVrt(source('a.tif', 0) + source('b.tif', 255));
    expectReject(vrt, /different <NODATA> values .*\(0, 255\)/);
  });

  it('rejects a cropped source even without SourceProperties', () => {
    // The size comparison needs SourceProperties, but a non-zero origin is a
    // crop regardless.
    const vrt = mosaicVrt(`<SimpleSource>
      <SourceFilename relativeToVRT="1">a.tif</SourceFilename>
      <SrcRect xOff="100" yOff="0" xSize="900" ySize="1000"/>
      <DstRect xOff="0" yOff="0" xSize="900" ySize="1000"/>
    </SimpleSource>`);
    expectReject(vrt, /reads only part of "a.tif"/);
  });

  it('rejects bands that place the same files differently', () => {
    const band = (n: number, xOff: number) =>
      `<VRTRasterBand dataType="Byte" band="${n}">
        <SimpleSource>
          <SourceFilename relativeToVRT="1">a.tif</SourceFilename>
          <SourceBand>${n}</SourceBand>
          <SrcRect xOff="0" yOff="0" xSize="100" ySize="100"/>
          <DstRect xOff="${xOff}" yOff="0" xSize="100" ySize="100"/>
        </SimpleSource>
      </VRTRasterBand>`;
    const vrt = `<VRTDataset rasterXSize="10" rasterYSize="10">${band(1, 0)}${band(2, 500)}</VRTDataset>`;
    expectReject(vrt, /places them differently/);
  });

  it('rejects a kernel-filtered source', () => {
    const vrt = mosaicVrt(`<KernelFilteredSource>
      <SourceFilename relativeToVRT="1">a.tif</SourceFilename>
      <Kernel><Size>3</Size><Coefs>1 1 1 1 1 1 1 1 1</Coefs></Kernel>
    </KernelFilteredSource>`);
    expectReject(vrt, /<KernelFilteredSource>/);
  });

  it('rejects a cropped source, since members render from their own georeferencing', () => {
    const vrt = mosaicVrt(`<SimpleSource>
      <SourceFilename relativeToVRT="1">a.tif</SourceFilename>
      <SourceProperties RasterXSize="1000" RasterYSize="1000"/>
      <SrcRect xOff="100" yOff="0" xSize="900" ySize="1000"/>
      <DstRect xOff="0" yOff="0" xSize="900" ySize="1000"/>
    </SimpleSource>`);
    expectReject(vrt, /reads only part of "a.tif"/);
  });

  it('rejects an on-the-fly rescaled placement', () => {
    const vrt = mosaicVrt(simpleSource('a.tif', { size: 1000, dstSize: 500 }));
    expectReject(vrt, /rescales "a.tif" on the fly/);
  });

  it('rejects band remapping', () => {
    const vrt = mosaicVrt(`<SimpleSource>
      <SourceFilename relativeToVRT="1">a.tif</SourceFilename>
      <SourceBand>3</SourceBand>
    </SimpleSource>`);
    expectReject(vrt, /built from band 3 of "a.tif"/);
  });

  it('rejects bands built from different file sets', () => {
    const band = (n: number, file: string) =>
      `<VRTRasterBand dataType="Byte" band="${n}">
        <SimpleSource>
          <SourceFilename relativeToVRT="1">${file}</SourceFilename>
          <SourceBand>${n}</SourceBand>
        </SimpleSource>
      </VRTRasterBand>`;
    const vrt = `<VRTDataset rasterXSize="10" rasterYSize="10">${band(1, 'a.tif')}${band(2, 'b.tif')}</VRTDataset>`;
    expectReject(vrt, /Band 2 .* different set of files/);
  });

  it('rejects a VRT with no bands', () => {
    expectReject(
      '<VRTDataset rasterXSize="10" rasterYSize="10"/>',
      /declares no raster bands/,
    );
  });

  it('rejects a band with no sources', () => {
    const vrt =
      '<VRTDataset rasterXSize="10" rasterYSize="10"><VRTRasterBand band="1"/></VRTDataset>';
    expectReject(vrt, /no <SimpleSource> entries/);
  });

  it('rejects unreadable /vsi handlers but not /vsicurl/', () => {
    const vrt = mosaicVrt(simpleSource('/vsis3/bucket/a.tif'));
    expectReject(vrt, /"vsis3" virtual filesystem/);
  });

  it('rejects local absolute paths with a rebuild hint', () => {
    expectReject(mosaicVrt(simpleSource('/data/a.tif')), /only exists on the machine/);
    expectReject(mosaicVrt(simpleSource('C:\\data\\a.tif')), /only exists on the machine/);
  });

  it('rejects relative sources when the VRT itself is a local file', () => {
    // A dropped .vrt is a blob: URL — the browser cannot reach its siblings.
    expectReject(
      mosaicVrt(simpleSource('tile_a.tif')),
      /local VRT file has no readable directory/,
      'blob:https://app.example/9f8c-1234',
    );
  });

  it('allows a local VRT whose sources are absolute URLs', () => {
    const mosaic = parseVrt(
      mosaicVrt(simpleSource('https://other.org/a.tif')),
      'blob:https://app.example/9f8c-1234',
    );
    expect(mosaic.members[0].url).toBe('https://other.org/a.tif');
  });
});
