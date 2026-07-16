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
 * carrying none of these (and no `<UseMaskBand>`) is equivalent to a
 * SimpleSource plus a nodata declaration — which is what gdalbuildvrt emits for
 * `-srcnodata` — so it is accepted and its `<NODATA>` carried. */
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
 * The element's `relativeToVRT` attribute is deliberately not consulted. It
 * distinguishes "relative to the .vrt" (`1`) from "relative to GDAL's working
 * directory" (`0`), and a browser has no working directory — so the VRT's own
 * location is the only resolution available for either. That is also the right
 * answer for the overwhelmingly common case of sources sitting beside the VRT.
 * Paths that are meaningful only on the authoring machine are rejected below
 * rather than silently resolved against the wrong base.
 *
 * @param filename - Raw text content of the element
 * @param vrtUrl - URL the VRT itself was loaded from
 * @returns An absolute http(s) URL
 * @throws {VrtUnsupportedError} When the path cannot be read from a browser
 */
function resolveSourceUrl(filename: string, vrtUrl: string): string {
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

/** Rejects a `<ComplexSource>` that rescales sample values or masks them
 * through a mask band. */
function assertPlainSource(source: Element, bandNumber: number): void {
  if (source.tagName !== 'ComplexSource') return;

  // Emitted by gdalbuildvrt whenever a source carries an internal mask band.
  // GDAL applies the mask per source while compositing; we draw each source as
  // its own layer with no per-source mask, so masked-out pixels would render as
  // data.
  if (firstChild(source, 'UseMaskBand')) {
    throw new VrtUnsupportedError(
      `Band ${bandNumber} of this VRT masks its sources through their mask ` +
        'bands (<UseMaskBand>), which GDAL applies while compositing. Each ' +
        'source is drawn on its own here, so the masks cannot be honoured and ' +
        'masked-out pixels would render as data. Materialize the VRT first ' +
        'with `gdal_translate mosaic.vrt mosaic.tif -of COG`, then load the ' +
        'result.',
    );
  }

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
 * The `<NODATA>` value a band's sources agree on, if any.
 *
 * A source's `<NODATA>` marks values in the *source* to skip while
 * compositing, which is exactly what this renderer needs: members are drawn
 * directly, so the value to mask is the one in their pixels. It is therefore
 * preferred over the band's `<NoDataValue>`, which describes the VRT's own
 * output (`gdalbuildvrt -srcnodata 255 -vrtnodata 0` makes them differ).
 *
 * Members share one nodata setting, so sources that disagree cannot be
 * honoured.
 *
 * @throws {VrtUnsupportedError} When sources declare different values
 */
function readSourceNodata(sources: Element[], bandNumber: number): number | null {
  const declared = sources
    .map((s) => firstChild(s, 'NODATA')?.textContent?.trim())
    .filter((v): v is string => v != null && v !== '');
  if (declared.length === 0) return null;

  const distinct = [...new Set(declared)];
  if (distinct.length > 1) {
    throw new VrtUnsupportedError(
      `Band ${bandNumber} of this VRT declares different <NODATA> values for ` +
        `different sources (${distinct.join(', ')}). Every source is drawn ` +
        'with the layer\'s single nodata setting here, so per-source nodata ' +
        'cannot be honoured. Materialize the VRT first with `gdal_translate ' +
        'mosaic.vrt mosaic.tif -of COG`, then load the result.',
    );
  }

  const value = Number(distinct[0]);
  return Number.isFinite(value) ? value : null;
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

  if (src) {
    // A non-zero origin is a crop regardless of whether <SourceProperties>
    // declares the full size; the size comparison needs it, so it only applies
    // when present.
    const fullX = props ? numAttr(props, 'RasterXSize', NaN) : NaN;
    const fullY = props ? numAttr(props, 'RasterYSize', NaN) : NaN;
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

/** What a single `<VRTRasterBand>` is built from: its members in document
 * order, plus the nodata its sources agree on (if any). */
function readBandMembers(
  band: Element,
  bandNumber: number,
  vrtUrl: string,
): { members: VrtMember[]; sourceNodata: number | null } {
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

  const members = sources.map((source) => {
    assertPlainSource(source, bandNumber);

    const fileEl = firstChild(source, 'SourceFilename');
    if (!fileEl) {
      throw new VrtUnsupportedError(
        `A source in band ${bandNumber} of this VRT has no <SourceFilename>.`,
      );
    }
    const filename = fileEl.textContent ?? '';

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
    return { url: resolveSourceUrl(filename, vrtUrl), dst };
  });

  return {
    members,
    sourceNodata: readSourceNodata(sources, bandNumber),
  };
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

  // Read every band, then require they agree on the mosaic — same files, in the
  // same order, at the same placement. Bands that disagree describe a per-band
  // file set or a per-band layout, neither of which can collapse to "render
  // each file once".
  const perBand = bands.map((band, i) => readBandMembers(band, i + 1, vrtUrl));
  const [first, ...rest] = perBand;
  const samePlacement = (a: VrtMember, b: VrtMember): boolean =>
    a.url === b.url &&
    a.dst.xOff === b.dst.xOff &&
    a.dst.yOff === b.dst.yOff &&
    // NaN sizes (no <DstRect>) compare equal to each other via Object.is.
    Object.is(a.dst.xSize, b.dst.xSize) &&
    Object.is(a.dst.ySize, b.dst.ySize);

  for (const [i, { members }] of rest.entries()) {
    const agrees =
      members.length === first.members.length &&
      members.every((m, j) => samePlacement(m, first.members[j]));
    if (!agrees) {
      throw new VrtUnsupportedError(
        `Band ${i + 2} of this VRT is built from a different set of files (or ` +
          'places them differently) than band 1. Only VRTs where every band ' +
          'reads the same mosaic of sources are supported. Materialize this ' +
          'one first with `gdal_translate mosaic.vrt mosaic.tif -of COG`, ' +
          'then load the result.',
      );
    }
  }

  return {
    members: first.members,
    bandCount: bands.length,
    // A source's <NODATA> describes the values to skip in the member's own
    // pixels, which is what gets rendered here; the band's <NoDataValue>
    // describes the VRT's output and is only a fallback. gdalbuildvrt writes
    // both and they usually agree, but `-srcnodata X -vrtnodata Y` makes them
    // differ — and X is the one this renderer needs.
    nodata: first.sourceNodata ?? parseNodata(bands[0]),
  };
}

/** True when `url` points at a `.vrt`, ignoring any query string or fragment.
 * Works for relative URLs too, which have no scheme to key off. */
export function isVrtUrl(url: string): boolean {
  return /\.vrt$/i.test(url.split(/[?#]/)[0]);
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
