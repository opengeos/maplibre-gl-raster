import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import { moveLayersIntoOrder } from '../src/lib/state/layer-order';

/** A map whose moveLayer mirrors MapLibre's Style.moveLayer on a plain list. */
function makeMap(initial: string[], withOrder = true) {
  const order = [...initial];
  const moveLayer = vi.fn((id: string, before?: string) => {
    order.splice(order.indexOf(id), 1);
    order.splice(before ? order.indexOf(before) : order.length, 0, id);
  });
  const map = {
    moveLayer,
    ...(withOrder ? { getLayersOrder: () => [...order] } : {}),
  } as unknown as MapLibreMap;
  return { map, moveLayer, order };
}

describe('moveLayersIntoOrder', () => {
  it('skips every move when the order is already right', () => {
    const { map, moveLayer } = makeMap(['base', 'a', 'b', 'label']);
    moveLayersIntoOrder(map, [
      { id: 'a', before: 'label' },
      { id: 'b', before: 'label' },
    ]);
    expect(moveLayer).not.toHaveBeenCalled();
  });

  it('skips moves to the top when the layers already end the stack', () => {
    const { map, moveLayer } = makeMap(['base', 'a', 'b']);
    moveLayersIntoOrder(map, [
      { id: 'a', before: undefined },
      { id: 'b', before: undefined },
    ]);
    expect(moveLayer).not.toHaveBeenCalled();
  });

  it('applies all moves when any layer is out of place', () => {
    const { map, moveLayer, order } = makeMap(['base', 'b', 'a', 'label']);
    moveLayersIntoOrder(map, [
      { id: 'a', before: 'label' },
      { id: 'b', before: 'label' },
    ]);
    expect(moveLayer).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['base', 'a', 'b', 'label']);
  });

  it('moves unconditionally on a map without getLayersOrder', () => {
    const { map, moveLayer } = makeMap(['base', 'a'], false);
    moveLayersIntoOrder(map, [{ id: 'a', before: undefined }]);
    expect(moveLayer).toHaveBeenCalledOnce();
  });

  it('lets moveLayer report a layer missing from the order', () => {
    const { map, moveLayer } = makeMap(['base']);
    moveLayer.mockImplementation(() => undefined);
    moveLayersIntoOrder(map, [{ id: 'ghost', before: undefined }]);
    expect(moveLayer).toHaveBeenCalledOnce();
  });
});
