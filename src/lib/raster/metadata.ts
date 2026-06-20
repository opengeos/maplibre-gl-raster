import {
  Compression,
  Photometric,
  PlanarConfiguration,
  Predictor,
  SampleFormat,
  TiffTag,
} from '@cogeotiff/core';
import type { GeoTIFF, Overview } from '@developmentseed/geotiff';

/** A single `<Item>` from `<GDALMetadata>`. `sample` is 1-based when present
 * (GDAL writes 0-based; we normalize). `role` is the optional `role` attribute
 * (e.g. `"description"`). */
export type GdalItem = {
  name: string;
  value: string;
  sample: number | null;
  role: string | null;
};

export type BandSummary = {
  /** 1-based band index. */
  index: number;
  /** Human label from `<Item name="DESCRIPTION" sample="N-1">…</Item>` or
   * the `BAND_NAME` alias. */
  name: string | null;
  /** GDAL scale; defaults to 1. */
  scale: number;
  /** GDAL offset; defaults to 0. */
  offset: number;
  /** Per-band nodata (currently always the dataset-level value — TIFF
   * doesn't carry per-band nodata in the common path). */
  nodata: number | null;
  /** Author-supplied min/max/mean/std/validPercent from `STATISTICS_*` items. */
  stats: {
    min: number | null;
    max: number | null;
    mean: number | null;
    std: number | null;
    validPercent: number | null;
  } | null;
};

export type ImageSummary = {
  width: number;
  height: number;
  bandCount: number;
  dtype: string;
  photometric: string;
  compression: string;
  predictor: string | null;
  planarConfig: string;
  tileWidth: number;
  tileHeight: number;
  nodata: number | null;
};

export type CrsSummary = {
  /** EPSG code when the COG declares one; null for user-defined CRSes. */
  code: number | null;
  /** Display label: `"EPSG:3857"` or `"User-defined: <name>"`. */
  label: string;
  /** `GTCitationGeoKey` or projected / geodetic citation, when present. */
  citation: string | null;
  /** Geographic-or-projected bbox `[minX, minY, maxX, maxY]` in the CRS. */
  bbox: [number, number, number, number];
  /** `ModelPixelScale` `[scaleX, scaleY]` when present. */
  pixelScale: [number, number] | null;
};

export type OverviewSummary = {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  tileCount: { x: number; y: number };
};

export type MetadataSummary = {
  image: ImageSummary;
  crs: CrsSummary;
  overviews: OverviewSummary[];
  bands: BandSummary[];
  /** GDAL `<Item>` entries that aren't already shown under Bands
   * (i.e. excludes `STATISTICS_*`, `DESCRIPTION`, `BAND_NAME`).
   * Dataset-level items first, then per-band, in document order. */
  gdalItems: GdalItem[];
  rawGdalXml: string | null;
};

const SAMPLE_FORMAT_LABELS: Record<number, string> = {
  [SampleFormat.Uint]: 'uint',
  [SampleFormat.Int]: 'int',
  [SampleFormat.Float]: 'float',
  [SampleFormat.Void]: 'void',
  [SampleFormat.ComplexInt]: 'cint',
  [SampleFormat.ComplexFloat]: 'cfloat',
};

const PHOTOMETRIC_LABELS: Record<number, string> = {
  [Photometric.MinIsWhite]: 'min-is-white',
  [Photometric.MinIsBlack]: 'min-is-black',
  [Photometric.Rgb]: 'RGB',
  [Photometric.Palette]: 'palette',
  [Photometric.Mask]: 'mask',
  [Photometric.Separated]: 'separated',
  [Photometric.Ycbcr]: 'YCbCr',
  [Photometric.Cielab]: 'CIE L*a*b*',
  [Photometric.Icclab]: 'ICC L*a*b*',
  [Photometric.Itulab]: 'ITU L*a*b*',
  [Photometric.Cfa]: 'CFA',
  [Photometric.Logl]: 'LogL',
  [Photometric.Logluv]: 'LogLuv',
};

const COMPRESSION_LABELS: Record<number, string> = {
  [Compression.None]: 'none',
  [Compression.Ccittrle]: 'CCITT RLE',
  [Compression.CcittT4]: 'CCITT T.4',
  [Compression.CcittT6]: 'CCITT T.6',
  [Compression.Lzw]: 'LZW',
  [Compression.Jpeg6]: 'old-JPEG',
  [Compression.Jpeg]: 'JPEG',
  [Compression.DeflateOther]: 'Deflate (Adobe)',
  [Compression.PackBits]: 'PackBits',
  [Compression.Deflate]: 'Deflate',
  [Compression.Lerc]: 'LERC',
  [Compression.Lzma]: 'LZMA',
  [Compression.Zstd]: 'ZSTD',
  [Compression.Webp]: 'WebP',
  [Compression.JpegXl]: 'JPEG XL',
  [Compression.JpegXlDng17]: 'JPEG XL (DNG 1.7)',
  [Compression.Jp2000]: 'JPEG 2000',
};

const PREDICTOR_LABELS: Record<number, string> = {
  [Predictor.None]: 'none',
  [Predictor.Horizontal]: 'horizontal',
  [Predictor.FloatingPoint]: 'floating-point',
};

const PLANAR_LABELS: Record<number, string> = {
  [PlanarConfiguration.Contig]: 'chunky (interleaved)',
  [PlanarConfiguration.Separate]: 'planar',
};

function labelOr(map: Record<number, string>, code: number | null | undefined): string {
  if (code === null || code === undefined) return 'unknown';
  return map[code] ?? `unknown (${code})`;
}

/** "uint8" / "float32" / etc. Falls back to e.g. "uint?" when bit-depth is
 * unknown. */
export function dtypeLabel(format: number | null | undefined, bits: number | null | undefined): string {
  const base = labelOr(SAMPLE_FORMAT_LABELS, format ?? null);
  if (!bits) return `${base}?`;
  return `${base}${bits}`;
}

export function compressionLabel(code: number | null | undefined): string {
  return labelOr(COMPRESSION_LABELS, code ?? null);
}

export function photometricLabel(code: number | null | undefined): string {
  return labelOr(PHOTOMETRIC_LABELS, code ?? null);
}

export function predictorLabel(code: number | null | undefined): string | null {
  if (code === null || code === undefined || code === Predictor.None) return null;
  return labelOr(PREDICTOR_LABELS, code);
}

export function planarConfigLabel(code: number | null | undefined): string {
  return labelOr(PLANAR_LABELS, code ?? null);
}

/** Parse every `<Item>` under `<GDALMetadata>`. Returns `[]` on missing,
 * empty, or unparsable input. The `sample` attribute is normalized to a
 * 1-based number to match GDAL's external convention; absent → null. */
export function parseGdalItems(raw: string | null | undefined): GdalItem[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(raw, 'text/xml');
  } catch {
    return [];
  }
  // DOMParser returns a document with a <parsererror> element on failure
  // rather than throwing — check for that explicitly.
  if (doc.getElementsByTagName('parsererror').length > 0) return [];

  const out: GdalItem[] = [];
  for (const item of Array.from(doc.querySelectorAll('Item'))) {
    const name = item.getAttribute('name');
    if (!name) continue;
    const sampleAttr = item.getAttribute('sample');
    let sample: number | null = null;
    if (sampleAttr !== null) {
      const n = parseInt(sampleAttr, 10);
      sample = Number.isFinite(n) && n >= 0 ? n + 1 : null;
    }
    out.push({
      name,
      value: item.textContent?.trim() ?? '',
      sample,
      role: item.getAttribute('role'),
    });
  }
  return out;
}

const BAND_RESERVED_NAMES = new Set([
  'DESCRIPTION',
  'BAND_NAME',
  'STATISTICS_MINIMUM',
  'STATISTICS_MAXIMUM',
  'STATISTICS_MEAN',
  'STATISTICS_STDDEV',
  'STATISTICS_VALID_PERCENT',
]);

/** Drop the items that are already surfaced under Bands so they don't
 * duplicate in the "GDAL items" list. */
export function filterUserGdalItems(items: GdalItem[]): GdalItem[] {
  return items.filter(
    (it) => !(it.sample !== null && BAND_RESERVED_NAMES.has(it.name)),
  );
}

/** Pretty-print a GDAL_METADATA XML string with 2-space indentation. Returns
 * the input verbatim when parsing fails so the user can still see the raw
 * bytes. */
export function prettyPrintGdalXml(raw: string): string {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(raw, 'text/xml');
  } catch {
    return raw;
  }
  if (doc.getElementsByTagName('parsererror').length > 0) return raw;
  const root = doc.documentElement;
  if (!root) return raw;
  const lines: string[] = [];
  serialize(root, 0, lines);
  return lines.join('\n');
}

function serialize(node: Element, depth: number, out: string[]): void {
  const indent = '  '.repeat(depth);
  const attrs = Array.from(node.attributes)
    .map((a) => ` ${a.name}="${escapeAttr(a.value)}"`)
    .join('');
  const children = Array.from(node.childNodes);
  const elementChildren = children.filter(
    (c): c is Element => c.nodeType === 1,
  );
  const text = children
    .filter((c) => c.nodeType === 3)
    .map((c) => c.textContent ?? '')
    .join('')
    .trim();

  if (elementChildren.length === 0) {
    if (text.length === 0) {
      out.push(`${indent}<${node.nodeName}${attrs}/>`);
    } else {
      out.push(`${indent}<${node.nodeName}${attrs}>${escapeText(text)}</${node.nodeName}>`);
    }
    return;
  }
  out.push(`${indent}<${node.nodeName}${attrs}>`);
  for (const child of elementChildren) serialize(child, depth + 1, out);
  out.push(`${indent}</${node.nodeName}>`);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** Resolve the EPSG code (or null) and a display label from a `crs` value.
 * A `crs` may be a numeric EPSG code, a PROJJSON object, or a WKT/ESRI-PE
 * string (the recovery path for projections the geo keys cannot express, see
 * repair-geokeys.ts). */
export function crsLabel(
  crs: number | string | { name?: string } | null | undefined,
): {
  code: number | null;
  label: string;
} {
  if (typeof crs === 'number') {
    return { code: crs, label: `EPSG:${crs}` };
  }
  if (typeof crs === 'string') {
    // Pull the CRS name out of the leading `PROJCS["name",...]` (or PROJCRS /
    // GEOGCS / GEOGCRS) so the panel shows e.g. "User-defined: World_Mollweide".
    const name = /\b(?:PROJCS|PROJCRS|GEOGCS|GEOGCRS)\s*\[\s*"([^"]+)"/i.exec(crs);
    return { code: null, label: name ? `User-defined: ${name[1]}` : 'User-defined' };
  }
  if (crs && typeof crs === 'object' && 'name' in crs && typeof crs.name === 'string') {
    return { code: null, label: `User-defined: ${crs.name}` };
  }
  return { code: null, label: 'unknown' };
}

/** Structural subset of `GeoTIFF` we read from. Lets tests construct stubs
 * without instantiating the whole class. The real `GeoTIFF` satisfies this. */
type MetadataInput = Pick<
  GeoTIFF,
  | 'image'
  | 'width'
  | 'height'
  | 'count'
  | 'tileWidth'
  | 'tileHeight'
  | 'nodata'
  | 'crs'
  | 'bbox'
  | 'cachedTags'
  | 'gkd'
  | 'offsets'
  | 'scales'
  | 'storedStats'
  | 'overviews'
>;

/** Pure derivation from an already-loaded GeoTIFF: no fetches, no I/O. */
export function summarizeGeoTIFF(tiff: MetadataInput): MetadataSummary {
  const cached = tiff.cachedTags;
  const sampleFormat = cached.sampleFormat?.[0] ?? null;
  const bits = cached.bitsPerSample?.[0] ?? null;

  const rawXml =
    (tiff.image.value(TiffTag.GdalMetadata) as string | undefined) ?? null;
  const items = parseGdalItems(rawXml);
  const itemsBySample = new Map<number, GdalItem[]>();
  for (const it of items) {
    if (it.sample === null) continue;
    const arr = itemsBySample.get(it.sample) ?? [];
    arr.push(it);
    itemsBySample.set(it.sample, arr);
  }

  const bands: BandSummary[] = [];
  for (let i = 1; i <= tiff.count; i++) {
    const own = itemsBySample.get(i) ?? [];
    const find = (n: string): string | null =>
      own.find((it) => it.name === n)?.value ?? null;
    const num = (s: string | null): number | null => {
      if (s === null) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };
    const name = find('DESCRIPTION') ?? find('BAND_NAME');
    const stats = own.some((it) => BAND_RESERVED_NAMES.has(it.name) && it.name.startsWith('STATISTICS_'))
      ? {
          min: num(find('STATISTICS_MINIMUM')),
          max: num(find('STATISTICS_MAXIMUM')),
          mean: num(find('STATISTICS_MEAN')),
          std: num(find('STATISTICS_STDDEV')),
          validPercent: num(find('STATISTICS_VALID_PERCENT')),
        }
      : null;
    bands.push({
      index: i,
      name,
      scale: tiff.scales[i - 1] ?? 1,
      offset: tiff.offsets[i - 1] ?? 0,
      nodata: tiff.nodata,
      stats,
    });
  }

  const { code, label } = crsLabel(tiff.crs as never);
  const gkd = tiff.gkd;
  const citation =
    gkd.citation || gkd.projectedCitation || gkd.geodeticCitation || null;
  const pixelScale =
    cached.modelPixelScale !== null && cached.modelPixelScale !== undefined
      ? ([
          cached.modelPixelScale[0],
          cached.modelPixelScale[1],
        ] as [number, number])
      : null;

  const overviews: OverviewSummary[] = tiff.overviews.map((ov: Overview) => ({
    width: ov.width,
    height: ov.height,
    tileWidth: ov.tileWidth,
    tileHeight: ov.tileHeight,
    tileCount: { x: ov.tileCount.x, y: ov.tileCount.y },
  }));

  return {
    image: {
      width: tiff.width,
      height: tiff.height,
      bandCount: tiff.count,
      dtype: dtypeLabel(sampleFormat, bits),
      photometric: photometricLabel(cached.photometric),
      compression: compressionLabel(cached.compression),
      predictor: predictorLabel(cached.predictor),
      planarConfig: planarConfigLabel(cached.planarConfiguration),
      tileWidth: tiff.tileWidth,
      tileHeight: tiff.tileHeight,
      nodata: tiff.nodata,
    },
    crs: {
      code,
      label,
      citation,
      bbox: tiff.bbox,
      pixelScale,
    },
    overviews,
    bands,
    gdalItems: filterUserGdalItems(items),
    rawGdalXml: rawXml,
  };
}
