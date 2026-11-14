import type { Map as MapLibreMap } from 'maplibre-gl';

/** One requested `map.moveLayer(id, before)` call. */
export interface LayerMove {
  id: string;
  before: string | undefined;
}

/**
 * Applies a sequence of `moveLayer` calls, skipping them entirely when they
 * would leave the style's layer order unchanged.
 *
 * MapLibre's `Style.moveLayer` marks the style changed even when the layer is
 * already in place, and the next frame then fires `styledata`. The native
 * engines re-apply on every `styledata` (that is how they restore their layers
 * after `setStyle()`), so an unconditional reorder fed itself: one `styledata`
 * per frame, forever, which kept `map.loaded()` false and made anything that
 * waits for an idle map (printing, export) time out.
 *
 * The moves are simulated against `map.getLayersOrder()` first. A map without
 * that method (older MapLibre, Mapbox) falls back to moving unconditionally.
 *
 * @param map - The map whose layers are reordered.
 * @param moves - The moves, in the order they would be applied.
 */
export function moveLayersIntoOrder(map: MapLibreMap, moves: LayerMove[]): void {
  if (moves.length === 0) return;
  const getOrder = (map as { getLayersOrder?: () => string[] }).getLayersOrder;
  if (typeof getOrder === 'function') {
    let current: string[] | undefined;
    try {
      current = getOrder.call(map);
    } catch {
      current = undefined;
    }
    if (Array.isArray(current) && !changesOrder(current, moves)) return;
  }
  for (const { id, before } of moves) {
    try {
      map.moveLayer(id, before);
    } catch {
      // Ignore transient ordering errors during style churn.
    }
  }
}

/**
 * Whether replaying `moves` the way `Style.moveLayer` does would change the
 * given layer order.
 *
 * @param order - The current bottom-to-top layer ids.
 * @param moves - The moves to simulate.
 * @returns True when at least one layer would end up somewhere else.
 */
function changesOrder(order: string[], moves: LayerMove[]): boolean {
  const next = [...order];
  for (const { id, before } of moves) {
    if (id === before) continue;
    const index = next.indexOf(id);
    // Unknown ids make moveLayer report an error; let the real call do that.
    if (index === -1) return true;
    if (before !== undefined && !next.includes(before)) return true;
    next.splice(index, 1);
    const target = before !== undefined ? next.indexOf(before) : next.length;
    next.splice(target, 0, id);
  }
  return next.some((id, index) => id !== order[index]);
}
