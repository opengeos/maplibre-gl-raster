/**
 * GDAL VRT (Virtual Format) support, limited to plain mosaics of COGs.
 *
 * A `.vrt` file is not raster data: it is a GDAL XML manifest describing how to
 * assemble *other* files. GDAL is not available in the browser, so this module
 * supports only the subset that can be honoured without it — a VRT whose bands
 * are built from sources that place each file at its natural position and
 * resolution, which is what `gdalbuildvrt` emits for a mosaic. Each member is
 * then loaded as its own COG and rendered as its own tiled layer, georeferenced
 * by its own headers, sharing one visualization state (see
 * {@link import('../state/LayerManager').LayerManager.addRaster}).
 *
 * The consequence of georeferencing each member independently is that this
 * module never applies the VRT's own `GeoTransform` / `DstRect` placement. That
 * is only safe while the VRT places sources exactly where their own headers
 * already put them, so {@link parseVrt} rejects anything that repositions,
 * crops, or rescales a source. Likewise it rejects everything that needs GDAL's
 * pixel machinery — warping, pixel functions, LUTs, scale/offset, kernel
 * filters. A mis-placed or silently rescaled raster is worse than a clear
 * failure, so these are hard errors rather than best-effort renders.
 */

/** Marker for a VRT this module deliberately refuses to render. Carries an
 * actionable message naming the GDAL command that would produce a supported
 * file. */
export class VrtUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VrtUnsupportedError';
  }
}

/** One source file referenced by a mosaic VRT. */
export interface VrtMember {
  /** Absolute http(s) URL, resolved against the VRT's own URL. */
  url: string;
  /** Placement of the member in VRT pixel space, from `<DstRect>`. Not used to
   * render (each member is georeferenced by its own headers) — retained so
   * callers can order or debug members. */
  dst: { xOff: number; yOff: number; xSize: number; ySize: number };
}

/** A parsed, validated mosaic VRT. */
export interface VrtMosaic {
  /** Member COGs in VRT source order. Always at least one. */
  members: VrtMember[];
  /** Number of `<VRTRasterBand>` elements; every member supplies all of them. */
  bandCount: number;
  /** Band-1 `<NoDataValue>`, when the VRT declares one and it is finite. */
  nodata: number | null;
}

/** GDAL virtual filesystem prefix for HTTP range reads — the one `vsi` handler
 * that maps cleanly onto a browser fetch. */
const VSICURL_PREFIX = '/vsicurl/';

/** Sources that composite through GDAL's pixel machinery rather than simply
 * placing a file. Detected by element name so the message can name the culprit. */
const UNSUPPORTED_SOURCE_ELEMENTS = [
  'KernelFilteredSource',
  'AveragedSource',
  'NoDataFromMaskSource',
];

/** `<ComplexSource>` children that transform sample values. A ComplexSource
 * carrying none of these is equivalent to a SimpleSource (gdalbuildvrt emits
 * one whenever `-srcnodata` is given), so it is accepted. */
const COMPLEX_SOURCE_TRANSFORMS = [
  'LUT',
  'ScaleOffset',
  'ScaleRatio',
  'Exponent',
  'ColorTableComponent',
];

/** True when `url` is an http(s) URL (the only thing a member can be read
 * from). */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** True for paths that only mean something to a local GDAL process: POSIX
 * absolute, Windows drive-letter, or a file: URL. */
function isLocalAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^file:/i.test(path);
}

function firstChild(parent: Element, tag: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.tagName === tag) return child;
  }
  return null;
}

function childrenNamed(parent: Element, tag: string): Element[] {
  return Array.from(parent.children).filter((c) => c.tagName === tag);
}

/** Reads a numeric XML attribute, returning `fallback` when absent/unparsable. */
function numAttr(el: Element, name: string, fallback: number): number {
  const raw = el.getAttribute(name);
  if (raw == null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Resolves a `<SourceFilename>` to an absolute http(s) URL.
 *
 * @param filename - Raw text content of the element
 * @param relativeToVrt - Value of the `relativeToVRT` attribute
 * @param vrtUrl - URL the VRT itself was loaded from
 * @returns An absolute http(s) URL
 * @throws {VrtUnsupportedError} When the path cannot be read from a browser
 */
function resolveSourceUrl(
  filename: string,
  relativeToVrt: boolean,
  vrtUrl: string,
): string {
  let raw = filename.trim();
  if (!raw) {
    throw new VrtUnsupportedError('This VRT has an empty <SourceFilename>.');
  }

  // /vsicurl/https://… is just an HTTP range read; strip the prefix and use the
  // rest. Every other /vsi*/ handler (vsis3, vsizip, vsigzip, …) needs GDAL
  // driver config we cannot reconstruct.
  if (raw.startsWith(VSICURL_PREFIX)) {
    raw = raw.slice(VSICURL_PREFIX.length);
  } else if (/^\/vsi[a-z0-9_]*\//i.test(raw)) {
    const handler = raw.slice(1, raw.indexOf('/', 1));
    throw new VrtUnsupportedError(
      `This VRT reads sources through GDAL's "${handler}" virtual filesystem, ` +
        'which the browser cannot open. Rewrite <SourceFilename> to a plain ' +
        'https:// URL (or /vsicurl/https://…) pointing at a CORS-enabled COG.',
    );
  }

  if (isHttpUrl(raw)) return raw;

  if (isLocalAbsolutePath(raw)) {
    throw new VrtUnsupportedError(
      `This VRT references the local path "${raw}", which only exists on the ` +
        'machine that built it. Rebuild the VRT with paths relative to the ' +
        '.vrt file (run gdalbuildvrt from the directory holding the sources), ' +
        'or rewrite each <SourceFilename> to an https:// URL.',
    );
  }

  // A relative member is resolvable only when the VRT itself came from a URL.
  // A dropped .vrt File is a blob: URL with no directory to resolve against —
  // the browser gives no access to its siblings on disk.
  if (!isHttpUrl(vrtUrl)) {
    throw new VrtUnsupportedError(
      `This VRT references "${raw}" relative to its own location, but a local ` +
        'VRT file has no readable directory in the browser — its sources ' +
        'cannot be found on disk. Load the VRT from a URL instead, or rewrite ' +
        'each <SourceFilename> to an absolute https:// URL.',
    );
  }

  // relativeToVRT="0" with a bare relative path means "relative to GDAL's
  // working directory". We have no better guess than the VRT's own location,
  // which is also what it resolves to for the (overwhelmingly common) case of
  // sources sitting beside the VRT.
  void relativeToVrt;
  return new URL(raw, vrtUrl).href;
}

/** Rejects the dataset-level constructs that need GDAL to render. */
function assertSupportedDataset(root: Element): void {
  const subClass = root.getAttribute('subClass');
  if (subClass === 'VRTWarpedDataset') {
    throw new VrtUnsupportedError(
      'This is a warped VRT (subClass="VRTWarpedDataset"): it reprojects or ' +
        'resamples its sources on the fly, which needs GDAL. Materialize it ' +
        'first with `gdalwarp mosaic.vrt mosaic.tif -of COG`, then load the ' +
        'resulting COG.',
    );
  }
  if (subClass === 'VRTPansharpenedDataset') {
    throw new VrtUnsupportedError(
      'This is a pansharpened VRT (subClass="VRTPansharpenedDataset"), which ' +
        'needs GDAL to fuse its bands. Materialize it first with ' +
        '`gdal_translate mosaic.vrt mosaic.tif -of COG`, then load the result.',
    );
  }
  if (subClass) {
    throw new VrtUnsupportedError(
      `This VRT uses subClass="${subClass}", which needs GDAL to render. ` +
        'Materialize it first with `gdal_translate mosaic.vrt mosaic.tif ' +
        '-of COG`, then load the result.',
    );
  }
}

/** Rejects the band-level constructs that need GDAL to render. */
function assertSupportedBand(band: Element, bandNumber: number): void {
  const subClass = band.getAttribute('subClass');
  if (subClass === 'VRTDerivedRasterBand' || firstChild(band, 'PixelFunctionType')) {
    const fn = firstChild(band, 'PixelFunctionType')?.textContent?.trim();
    throw new VrtUnsupportedError(
      `Band ${bandNumber} of this VRT is computed by a pixel function` +
        `${fn ? ` ("${fn}")` : ''}, which runs inside GDAL. Materialize the ` +
        'VRT first with `gdal_translate mosaic.vrt mosaic.tif -of COG`, then ' +
        'load the result.',
    );
  }
  if (subClass) {
    throw new VrtUnsupportedError(
      `Band ${bandNumber} of this VRT uses subClass="${subClass}", which needs ` +
        'GDAL to render. Materialize it first with `gdal_translate mosaic.vrt ' +
        'mosaic.tif -of COG`, then load the result.',
    );
  }
  for (const tag of UNSUPPORTED_SOURCE_ELEMENTS) {
    if (firstChild(band, tag)) {
      throw new VrtUnsupportedError(
        `Band ${bandNumber} of this VRT uses <${tag}>, which composites pixels ` +
          'inside GDAL. Materialize the VRT first with `gdal_translate ' +
          'mosaic.vrt mosaic.tif -of COG`, then load the result.',
      );
    }
  }
}

/** Rejects a `<ComplexSource>` that rescales sample values. */
function assertPlainSource(source: Element, bandNumber: number): void {
  if (source.tagName !== 'ComplexSource') return;
  for (const tag of COMPLEX_SOURCE_TRANSFORMS) {
    if (firstChild(source, tag)) {
      throw new VrtUnsupportedError(
        `Band ${bandNumber} of this VRT rescales its source through <${tag}>, ` +
          'which is applied by GDAL. Materialize the VRT first with ' +
          '`gdal_translate mosaic.vrt mosaic.tif -of COG`, then load the ' +
          'result.',
      );
    }
  }
}

/**
 * Rejects a source whose `<SrcRect>` / `<DstRect>` do not place the file at its
 * natural position and 1:1 scale.
 *
 * Members are rendered from their own georeferencing, so a VRT that crops a
 * source (partial SrcRect) or scales it (DstRect size ≠ SrcRect size) would
 * render as something other than what it describes.
 */
function assertNaturalPlacement(
  source: Element,
  bandNumber: number,
  filename: string,
): { xOff: number; yOff: number; xSize: number; ySize: number } {
  const props = firstChild(source, 'SourceProperties');
  const srcRect = firstChild(source, 'SrcRect');
  const dstRect = firstChild(source, 'DstRect');

  // Both rects are optional; absent means "the whole source, placed naturally",
  // which is exactly what we support.
  const src = srcRect
    ? {
        xOff: numAttr(srcRect, 'xOff', 0),
        yOff: numAttr(srcRect, 'yOff', 0),
        xSize: numAttr(srcRect, 'xSize', NaN),
        ySize: numAttr(srcRect, 'ySize', NaN),
      }
    : null;

  if (src && props) {
    const fullX = numAttr(props, 'RasterXSize', NaN);
    const fullY = numAttr(props, 'RasterYSize', NaN);
    const cropped =
      src.xOff !== 0 ||
      src.yOff !== 0 ||
      (Number.isFinite(fullX) && Number.isFinite(src.xSize) && src.xSize !== fullX) ||
      (Number.isFinite(fullY) && Number.isFinite(src.ySize) && src.ySize !== fullY);
    if (cropped) {
      throw new VrtUnsupportedError(
        `Band ${bandNumber} of this VRT reads only part of "${filename}" ` +
          '(<SrcRect> is a sub-window). Each source is drawn from its own ' +
          'georeferencing here, so the crop cannot be honoured. Materialize ' +
          'the VRT first with `gdal_translate mosaic.vrt mosaic.tif -of COG`, ' +
          'then load the result.',
      );
    }
  }

  const dst = dstRect
    ? {
        xOff: numAttr(dstRect, 'xOff', 0),
        yOff: numAttr(dstRect, 'yOff', 0),
        xSize: numAttr(dstRect, 'xSize', NaN),
        ySize: numAttr(dstRect, 'ySize', NaN),
      }
    : { xOff: 0, yOff: 0, xSize: NaN, ySize: NaN };

  if (
    src &&
    dstRect &&
    Number.isFinite(src.xSize) &&
    Number.isFinite(dst.xSize) &&
    (src.xSize !== dst.xSize || src.ySize !== dst.ySize)
  ) {
    throw new VrtUnsupportedError(
      `Band ${bandNumber} of this VRT rescales "${filename}" on the fly ` +
        `(${src.xSize}×${src.ySize} source pixels drawn into ${dst.xSize}×` +
        `${dst.ySize}). This usually means the sources have different ` +
        'resolutions. Materialize the VRT first with `gdalwarp mosaic.vrt ' +
        'mosaic.tif -of COG`, then load the result.',
    );
  }

  return dst;
}

/** Parses `<NoDataValue>` from band 1, ignoring the non-finite spellings GDAL
 * permits ("nan", "inf") since those are not usable as a shader uniform. */
function parseNodata(band: Element): number | null {
  const raw = firstChild(band, 'NoDataValue')?.textContent?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** The members a single `<VRTRasterBand>` is built from, in document order. */
function readBandMembers(
  band: Element,
  bandNumber: number,
  vrtUrl: string,
): VrtMember[] {
  assertSupportedBand(band, bandNumber);

  const sources = Array.from(band.children).filter(
    (c) => c.tagName === 'SimpleSource' || c.tagName === 'ComplexSource',
  );
  if (sources.length === 0) {
    throw new VrtUnsupportedError(
      `Band ${bandNumber} of this VRT has no <SimpleSource> entries, so there ` +
        'is no file to read. Only VRTs that mosaic existing rasters are ' +
        'supported.',
    );
  }

  return sources.map((source) => {
    assertPlainSource(source, bandNumber);

    const fileEl = firstChild(source, 'SourceFilename');
    if (!fileEl) {
      throw new VrtUnsupportedError(
        `A source in band ${bandNumber} of this VRT has no <SourceFilename>.`,
      );
    }
    const filename = fileEl.textContent ?? '';
    const relativeToVrt = fileEl.getAttribute('relativeToVRT') === '1';

    // Each member is loaded as a whole COG and its bands read by index, so a
    // band that pulls from a different band of the source cannot be honoured.
    const sourceBand = firstChild(source, 'SourceBand')?.textContent?.trim();
    if (sourceBand != null && sourceBand !== '' && Number(sourceBand) !== bandNumber) {
      throw new VrtUnsupportedError(
        `Band ${bandNumber} of this VRT is built from band ${sourceBand} of ` +
          `"${filename.trim()}". Band remapping is applied by GDAL and is not ` +
          'supported here. Materialize the VRT first with `gdal_translate ' +
          'mosaic.vrt mosaic.tif -of COG`, then load the result.',
      );
    }

    const dst = assertNaturalPlacement(source, bandNumber, filename.trim());
    return { url: resolveSourceUrl(filename, relativeToVrt, vrtUrl), dst };
  });
}

/**
 * Parses a mosaic VRT into the list of member COGs to render.
 *
 * @param xml - Raw `.vrt` XML text
 * @param vrtUrl - URL the VRT was loaded from; relative sources resolve
 *   against it
 * @returns The validated mosaic
 * @throws {VrtUnsupportedError} When the VRT is malformed, or uses any
 *   construct that needs GDAL (see the module doc)
 */
export function parseVrt(xml: string, vrtUrl: string): VrtMosaic {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // DOMParser reports XML syntax errors as a <parsererror> element in the
  // result rather than by throwing.
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new VrtUnsupportedError(
      'This file is not valid XML, so it cannot be read as a VRT.',
    );
  }

  const root = doc.documentElement;
  if (!root || root.tagName !== 'VRTDataset') {
    throw new VrtUnsupportedError(
      `Expected a <VRTDataset> root element but found <${root?.tagName ?? '?'}>. ` +
        'This does not look like a GDAL .vrt file.',
    );
  }
  assertSupportedDataset(root);

  const bands = childrenNamed(root, 'VRTRasterBand');
  if (bands.length === 0) {
    throw new VrtUnsupportedError(
      'This VRT declares no raster bands, so there is nothing to display.',
    );
  }

  // Read every band, then require they agree on the member list. Bands that
  // disagree describe a per-band file set, which cannot collapse to "render
  // each file as one layer".
  const perBand = bands.map((band, i) => readBandMembers(band, i + 1, vrtUrl));
  const [first, ...rest] = perBand;
  for (const [i, members] of rest.entries()) {
    const sameLength = members.length === first.length;
    const sameUrls =
      sameLength && members.every((m, j) => m.url === first[j].url);
    if (!sameUrls) {
      throw new VrtUnsupportedError(
        `Band ${i + 2} of this VRT is built from a different set of files than ` +
          'band 1. Only VRTs where every band reads the same mosaic of ' +
          'sources are supported. Materialize this one first with ' +
          '`gdal_translate mosaic.vrt mosaic.tif -of COG`, then load the ' +
          'result.',
      );
    }
  }

  return {
    members: first,
    bandCount: bands.length,
    nodata: parseNodata(bands[0]),
  };
}

/** True when `url` points at a `.vrt` (ignoring any query string). */
export function isVrtUrl(url: string): boolean {
  const path = url.includes('://') ? url.split('?')[0] : url;
  return /\.vrt$/i.test(path);
}

/** True when `file` is a `.vrt` by name. */
export function isVrtFile(file: { name: string }): boolean {
  return /\.vrt$/i.test(file.name);
}

/**
 * Fetches and parses a mosaic VRT.
 *
 * @param url - http(s) URL of the `.vrt`, or a blob: URL for a local file
 * @param signal - Aborts the fetch
 * @returns The validated mosaic
 * @throws {VrtUnsupportedError} When the VRT needs GDAL to render
 */
export async function loadVrt(
  url: string,
  signal?: AbortSignal,
): Promise<VrtMosaic> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch VRT (${response.status} ${response.statusText}): ${url}`,
    );
  }
  return parseVrt(await response.text(), url);
}
