import { describe, expect, it, vi } from 'vitest';
import { createResilientEpsgResolver } from '../src/lib/raster/epsg-resolver';

describe('createResilientEpsgResolver', () => {
  it('resolves EPSG:4326 offline without calling the fallback', async () => {
    const fallback = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const resolve = createResilientEpsgResolver({ fallback });

    const def = await resolve(4326);

    expect(fallback).not.toHaveBeenCalled();
    // wkt-parser shape: a geographic CRS in degrees.
    expect(def.units).toBe('degree');
    expect(def.projName).toBe('longlat');
  });

  it('delegates other codes to the fallback resolver', async () => {
    const fakeDef = { projName: 'utm', units: 'm' } as never;
    const fallback = vi.fn(async () => fakeDef);
    const resolve = createResilientEpsgResolver({ fallback });

    const def = await resolve(26916);

    expect(fallback).toHaveBeenCalledWith(26916);
    expect(def).toBe(fakeDef);
  });

  it('wraps fallback failures in a clear, actionable error', async () => {
    const fallback = vi.fn(async () => {
      throw new Error('Failed to fetch PROJJSON from https://epsg.io/26916.json');
    });
    const resolve = createResilientEpsgResolver({ fallback });

    await expect(resolve(26916)).rejects.toThrow(
      /Could not resolve coordinate system EPSG:26916/,
    );
    await expect(resolve(26916)).rejects.toThrow(/epsg\.io/);
  });

  it('preserves the underlying cause', async () => {
    const cause = new Error('network down');
    const resolve = createResilientEpsgResolver({
      fallback: async () => {
        throw cause;
      },
    });

    await expect(resolve(3035)).rejects.toMatchObject({ cause });
  });
});
