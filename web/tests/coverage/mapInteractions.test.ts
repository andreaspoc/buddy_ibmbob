// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => {
  const layers = new Set<any>();
  const map = { removeLayer: vi.fn((v: any) => layers.delete(v)), hasLayer: vi.fn((v: any) => layers.has(v)), fitBounds: vi.fn(), setView: vi.fn(), flyTo: vi.fn(), getZoom: () => 12, invalidateSize: vi.fn() };
  const markers: any[] = [];
  const leaflet = {
    map: vi.fn(() => map), divIcon: vi.fn((x: any) => x),
    tileLayer: vi.fn(() => ({ addTo() { return this; } })),
    featureGroup: vi.fn(() => ({ getBounds: () => ({ pad: () => ({}) }) })),
    marker: vi.fn(() => { const marker = { addTo() { layers.add(this); return this; }, bindPopup: vi.fn(function(this: any) { return this; }), on: vi.fn(function(this: any) { return this; }), openPopup: vi.fn(), setLatLng: vi.fn() }; markers.push(marker); return marker; }),
  };
  return { map, markers, leaflet, layers };
});
vi.mock('leaflet', () => ({ default: mocks.leaflet }));
import { renderMapToDOM } from '../../src/components/MapRenderer';
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });
test('initializes markers, filters locations, changes basemap and locates the user', async () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (ok: any) => ok({ coords: { latitude: 51, longitude: 0 } }) } });
  const el = renderMapToDOM({ places: [
    { name: 'London', lat: 51.5, lng: -0.1, category: 'Office', address: 'Main Street', rating: 4, description: 'City', url: 'javascript:alert(1)' },
    { name: 'Paris', lat: 48.8, lng: 2.3, category: 'Office' },
  ] });
  document.body.append(el);
  await vi.waitFor(() => expect(mocks.markers.length).toBe(2));
  expect(mocks.map.fitBounds).toHaveBeenCalled();
  const popup = mocks.markers[0].bindPopup.mock.calls[0][0] as HTMLElement;
  expect(popup.textContent).toContain('Main Street');
  expect(popup.querySelector('a')?.href).toMatch(/^https:\/\/www.google.com\/maps/);
  const input = el.querySelector('input') as HTMLInputElement;
  input.value = 'London'; input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(el.textContent).toContain('Showing 1 of 2');
  expect(mocks.map.removeLayer).toHaveBeenCalledWith(mocks.markers[1]);
  const streets = [...el.querySelectorAll('button')].find(b => b.textContent?.includes('Streets'))!;
  streets.click(); await vi.waitFor(() => expect(mocks.leaflet.tileLayer).toHaveBeenCalledTimes(3));
  const near = [...el.querySelectorAll('button')].find(b => b.textContent?.includes('Near Me'))!;
  near.click(); expect(mocks.markers.length).toBe(3); expect(near.textContent).toContain('Located');
});

test('shows a denied location request and restores the location control', async () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const getCurrentPosition = vi.fn((_success, failure) => failure({ code: 1 }));
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
  const previousMarkers = mocks.markers.length;
  const el = renderMapToDOM({ places: [{ name: 'London', lat: 51.5, lng: -0.1 }] });
  document.body.append(el);
  await vi.waitFor(() => expect(mocks.markers.length).toBe(previousMarkers + 1));
  const near = [...el.querySelectorAll('button')].find(b => b.textContent?.includes('Near Me'))!;
  vi.useFakeTimers();
  try {
    near.click();
    expect(getCurrentPosition).toHaveBeenCalledOnce();
    expect(near.textContent).toContain('Location Denied');
    vi.advanceTimersByTime(3000);
    expect(near.textContent).toContain('Near Me');
  } finally {
    vi.useRealTimers();
  }
});
