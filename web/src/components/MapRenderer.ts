import { themeCssValue } from '../lib/themeColor';
import { prefersReducedMotion, uiMotion, scrollBehavior } from '../lib/motion';
// Interactive Leaflet Map renderer for chat responses with Carbon Design System principles
// CVE-2025-69993: leaflet bindPopup(htmlString) is vulnerable to XSS.
// This file must only call bindPopup() with DOM elements, never with unsanitized strings.
import type * as LeafletType from 'leaflet';

let leafletModule: typeof LeafletType | null = null;
async function getLeaflet(): Promise<typeof LeafletType | null> {
  if (leafletModule) return leafletModule;
  if (typeof window === 'undefined') return null;
  try {
    const mod = await import('leaflet');
    leafletModule = (mod as any).default || mod;
    return leafletModule;
  } catch {
    return (window as any).L || null;
  }
}

export interface MapPlace {
  name: string;
  lat: number;
  lng: number;
  category?: string;
  rating?: number | string;
  address?: string;
  description?: string;
  url?: string;
  color?: string;
}

export interface MapSpec {
  title?: string;
  subtitle?: string;
  center?: [number, number]; // [lat, lng]
  zoom?: number;
  places: MapPlace[];
}

const THEME = {
  font: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  bg: '#ffffff',
  bgSubtle: '#f4f4f4',
  border: '#e0e0e0',
  borderSubtle: '#8d8d8d',
  textPrimary: '#161616',
  textSecondary: '#525252',
  textHelper: '#6f6f6f',
  primaryBlue: '#0f62fe',
  accentPurple: '#6929c4',
  tagBg: '#edf5ff',
  tagText: '#0043ce',
  starColor: '#b28600',
};

const PIN_PALETTE = ['#0f62fe', '#6929c4', '#0072c3', '#8a3ffc', '#1192e8', '#005d5d'];

type BasemapStyle = 'canvas' | 'streets' | 'satellite';

interface TileConfig {
  name: string;
  icon: string;
  description: string;
  layers: Array<{
    url: string;
    options: LeafletType.TileLayerOptions;
  }>;
}

const BASEMAP_TILES: Record<BasemapStyle, TileConfig> = {
  canvas: {
    name: 'Canvas',
    icon: '🗺️',
    description: 'Minimalist high-contrast gray canvas',
    layers: [
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        options: {
          attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
          maxZoom: 16,
        },
      },
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
        options: {
          attribution: '',
          maxZoom: 16,
        },
      },
    ],
  },
  streets: {
    name: 'Streets',
    icon: '🛣️',
    description: 'Detailed OpenStreetMap street layer',
    layers: [
      {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        options: {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
          subdomains: 'abc',
          maxZoom: 19,
        },
      },
    ],
  },
  satellite: {
    name: 'Satellite',
    icon: '🛰️',
    description: 'High-resolution satellite imagery',
    layers: [
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        options: {
          attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
          maxZoom: 18,
        },
      },
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        options: {
          attribution: '',
          maxZoom: 18,
        },
      },
    ],
  },
};

function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

/** Marker colors enter SVG markup, so accept only literal hex colors. */
function safeMapColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function safeMapUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : fallback;
  } catch { return fallback; }
}

function createPinIcon(L: typeof LeafletType, index: number, color: string, isActive = false): LeafletType.DivIcon {
  color = safeMapColor(color, PIN_PALETTE[index % PIN_PALETTE.length]);
  const pinSvg = `
    <div class="carbon-map-pin ${isActive ? 'is-active' : ''}" style="
      position: relative;
      width: 32px;
      height: 42px;
      cursor: pointer;
      filter: drop-shadow(0 3px 6px rgba(0,0,0,0.32));
      transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      ${isActive ? 'transform: translateY(-4px) scale(1.15); z-index: 1000;' : ''}
    ">
      <svg width="32" height="42" viewBox="0 0 32 42" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad-${index}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}"/>
            <stop offset="100%" stop-color="${color}dd"/>
          </linearGradient>
        </defs>
        <path d="M16 0C7.163 0 0 7.163 0 16c0 12.5 16 26 16 26s16-13.5 16-26c0-8.837-7.163-16-16-16z" fill="url(#grad-${index})"/>
        <circle cx="16" cy="15" r="10.5" fill="#ffffff"/>
        <text x="16" y="19" text-anchor="middle" font-family="${THEME.font}" font-size="11" font-weight="700" fill="${color}">${index + 1}</text>
      </svg>
      ${isActive ? `<div style="position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); width: 8px; height: 8px; border-radius: 50%; background: ${color}; box-shadow: 0 0 0 4px ${color}44;"></div>` : ''}
    </div>
  `;
  return L.divIcon({
    className: 'custom-carbon-pin-wrap',
    html: pinSvg,
    iconSize: [32, 42],
    iconAnchor: [16, 42],
    popupAnchor: [0, -38],
  });
}

function createUserLocationIcon(L: typeof LeafletType): LeafletType.DivIcon {
  const html = `
    <div style="position: relative; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;">
      <div style="position: absolute; width: 22px; height: 22px; border-radius: 50%; background: rgba(15, 98, 254, 0.25); animation: projects-pulse-subtle 2s infinite ease-out;"></div>
      <div style="width: 12px; height: 12px; border-radius: 50%; background: #0f62fe; border: 2.5px solid #ffffff; box-shadow: 0 2px 5px rgba(0,0,0,0.35);"></div>
    </div>
  `;
  return L.divIcon({
    className: 'user-location-pin',
    html,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

export function renderMapToDOM(spec: MapSpec): HTMLElement {
  const container = document.createElement('div');
  container.className = 'interactive-map-card';
  container.style.cssText = `
    border: 1px solid ${THEME.border};
    border-radius: 8px;
    background: ${THEME.bg};
    overflow: hidden;
    margin: 1.25em auto;
    font-family: ${THEME.font};
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
    display: flex;
    flex-direction: column;
    max-width: 100%;
    min-width: 0;
  `;

  const places: MapPlace[] = Array.isArray(spec.places) ? spec.places.filter(place =>
    place && typeof place.lat === 'number' && Number.isFinite(place.lat) && Math.abs(place.lat) <= 90
    && typeof place.lng === 'number' && Number.isFinite(place.lng) && Math.abs(place.lng) <= 180) : [];
  let userCoords: [number, number] | null = null;
  let activeStyle: BasemapStyle = 'canvas';

  // 1. Top Toolbar Header
  const header = document.createElement('div');
  header.className = 'buddy-toolbar map-toolbar';
  header.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid ${THEME.border};
    background: ${THEME.bg};
    gap: 10px;
    flex-wrap: wrap;
  `;

  const titleWrap = document.createElement('div');
  titleWrap.style.cssText = 'min-width: 0; flex: 1 1 180px; overflow-wrap: anywhere;';
  if (spec.title) {
    const title = document.createElement('h4');
    title.textContent = spec.title;
    title.style.cssText = 'margin: 0; font-size: 14px; font-weight: 600; color: inherit; letter-spacing: 0.16px;';
    titleWrap.appendChild(title);
  }
  if (spec.subtitle) {
    const subtitle = document.createElement('p');
    subtitle.textContent = spec.subtitle;
    subtitle.style.cssText = 'margin: 2px 0 0; font-size: 12px; color: inherit; opacity: 0.8;';
    titleWrap.appendChild(subtitle);
  }
  header.appendChild(titleWrap);

  // Center / Right Controls
  const controlsRow = document.createElement('div');
  controlsRow.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;';

  // Count badge
  const badge = document.createElement('span');
  badge.textContent = `${places.length} ${places.length === 1 ? 'SPOT' : 'SPOTS'}`;
  badge.style.cssText = `
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.4px;
    padding: 3px 8px;
    background: #edf5ff;
    color: #0043ce;
    border: 1px solid #d0e2ff;
    border-radius: 12px;
    flex-shrink: 0;
    text-transform: uppercase;
  `;
  controlsRow.appendChild(badge);

  // Basemap Segmented Switcher
  const switcher = document.createElement('div');
  switcher.className = 'map-style-switcher';
  switcher.style.cssText = `
    display: inline-flex;
    border: 1px solid ${THEME.border};
    border-radius: 4px;
    overflow: hidden;
    background: ${THEME.bgSubtle};
  `;

  const switcherButtons: Record<BasemapStyle, HTMLButtonElement> = {} as any;

  (['canvas', 'streets', 'satellite'] as BasemapStyle[]).forEach(styleKey => {
    const cfg = BASEMAP_TILES[styleKey];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `map-style-btn ${styleKey === activeStyle ? 'is-active' : ''}`;
    btn.title = cfg.description;
    btn.innerHTML = `<span>${cfg.icon}</span> ${cfg.name}`;
    btn.style.cssText = `
      border: none;
      background: ${styleKey === activeStyle ? '#0f62fe' : 'transparent'};
      color: ${styleKey === activeStyle ? '#ffffff' : THEME.textPrimary};
      font-size: 11px;
      font-weight: 600;
      padding: 4px 9px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: background 0.15s ease, color 0.15s ease;
    `;
    switcherButtons[styleKey] = btn;
    switcher.appendChild(btn);
  });
  controlsRow.appendChild(switcher);

  // Near Me / Proximity Button
  const nearMeBtn = document.createElement('button');
  nearMeBtn.type = 'button';
  nearMeBtn.className = 'map-action-button';
  nearMeBtn.innerHTML = '<span>📍</span> Near Me';
  nearMeBtn.title = 'Show distance from your current location';
  nearMeBtn.style.cssText = `
    border: 1px solid ${THEME.border};
    background: ${THEME.bg};
    color: ${THEME.textPrimary};
    font-size: 11px;
    font-weight: 500;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: background 0.15s ease;
  `;
  controlsRow.appendChild(nearMeBtn);

  // Fit All Button
  const fitBtn = document.createElement('button');
  fitBtn.type = 'button';
  fitBtn.className = 'map-action-button';
  fitBtn.innerHTML = '<span>⌖</span> Fit All';
  fitBtn.title = 'Zoom to fit all locations';
  fitBtn.style.cssText = `
    border: 1px solid ${THEME.border};
    background: ${THEME.bg};
    color: ${THEME.textPrimary};
    font-size: 11px;
    font-weight: 500;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: background 0.15s ease;
  `;
  controlsRow.appendChild(fitBtn);

  // Maximize Button
  const maximizeBtn = document.createElement('button');
  maximizeBtn.type = 'button';
  maximizeBtn.className = 'map-maximize-button';
  maximizeBtn.innerHTML = '<span>⛶</span> Fullscreen';
  maximizeBtn.setAttribute('aria-label', `Maximize map: ${spec.title || 'Map'}`);
  maximizeBtn.style.cssText = `
    border: 1px solid ${themeCssValue('#d4bbff')};
    border-radius: 4px;
    padding: 4px 9px;
    color: ${themeCssValue('#491d8b')};
    background: ${themeCssValue('#fbf7ff')};
    cursor: pointer;
    font: 600 11px ${THEME.font};
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: background 0.15s ease;
  `;
  controlsRow.appendChild(maximizeBtn);

  header.appendChild(controlsRow);
  container.appendChild(header);

  if (places.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.textContent = 'No map coordinates provided.';
    emptyMsg.style.cssText = `padding: 24px; text-align: center; color: ${THEME.textSecondary}; font-size: 13px;`;
    container.appendChild(emptyMsg);
    return container;
  }

  // 2. Map Canvas Viewport
  const mapCanvasWrap = document.createElement('div');
  mapCanvasWrap.className = 'map-canvas-container';
  mapCanvasWrap.style.cssText = 'width: 100%; height: 380px; position: relative; background: #eef2f5; min-height: 280px;';
  container.appendChild(mapCanvasWrap);

  // 3. Search / Filter Bar (if 3 or more places)
  let filterQuery = '';
  const searchRow = document.createElement('div');
  searchRow.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    background: var(--cds-layer-02, #fbfbfb);
    border-top: 1px solid ${THEME.border};
    border-bottom: 1px solid ${THEME.border};
    gap: 10px;
    font-size: 12px;
  `;

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = '🔍 Filter places by name or street...';
  searchInput.style.cssText = `
    flex: 1;
    max-width: 320px;
    padding: 5px 9px;
    font-size: 12px;
    border: 1px solid ${THEME.border};
    border-radius: 4px;
    background: #ffffff;
    color: inherit;
  `;
  searchRow.appendChild(searchInput);

  const filterStatus = document.createElement('span');
  filterStatus.textContent = `Showing ${places.length} of ${places.length}`;
  filterStatus.style.cssText = 'font-size: 11px; color: var(--cds-text-secondary, #525252);';
  searchRow.appendChild(filterStatus);

  container.appendChild(searchRow);

  // 4. Synchronized Place Cards Carousel
  const placeCardsWrap = document.createElement('div');
  placeCardsWrap.className = 'map-place-cards-carousel';
  placeCardsWrap.style.cssText = `
    display: flex;
    gap: 12px;
    padding: 12px 14px;
    overflow-x: auto;
    background: ${THEME.bg};
    scroll-behavior: smooth;
    -webkit-overflow-scrolling: touch;
  `;
  container.appendChild(placeCardsWrap);

  const cardElements: HTMLElement[] = [];

  const updateCardDistances = () => {
    if (!userCoords) return;
    places.forEach((p, idx) => {
      const card = cardElements[idx];
      if (!card) return;
      const distKm = calculateDistanceKm(userCoords![0], userCoords![1], p.lat, p.lng);
      let distBadge = card.querySelector('.pm-dist-badge') as HTMLElement;
      if (!distBadge) {
        distBadge = document.createElement('span');
        distBadge.className = 'pm-dist-badge';
        distBadge.style.cssText = `
          font-size: 10px;
          font-weight: 700;
          color: #0043ce;
          background: #edf5ff;
          border: 1px solid #d0e2ff;
          padding: 1px 5px;
          border-radius: 2px;
          margin-left: 6px;
        `;
        const head = card.querySelector('.pm-card-head');
        head?.appendChild(distBadge);
      }
      distBadge.textContent = `📍 ${formatDistance(distKm)} away`;
    });
  };

  places.forEach((place, idx) => {
    const color = safeMapColor(place.color, PIN_PALETTE[idx % PIN_PALETTE.length]);
    const card = document.createElement('div');
    card.className = 'map-place-card';
    card.setAttribute('tabindex', '0');
    card.style.cssText = `
      flex: 0 0 250px;
      min-width: 250px;
      max-width: 280px;
      border: 1px solid ${THEME.border};
      background: ${THEME.bg};
      border-radius: 6px;
      padding: 10px 12px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
    `;

    const cardHead = document.createElement('div');
    cardHead.className = 'pm-card-head';
    cardHead.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 6px;';

    const numBadge = document.createElement('span');
    numBadge.textContent = `#${idx + 1}`;
    numBadge.style.cssText = `font-size: 11px; font-weight: 700; color: ${color}; background: ${color}15; padding: 2px 6px; border-radius: 3px; border: 1px solid ${color}33;`;
    cardHead.appendChild(numBadge);

    if (place.category) {
      const catBadge = document.createElement('span');
      catBadge.textContent = place.category;
      catBadge.style.cssText = `font-size: 10px; font-weight: 600; background: ${THEME.tagBg}; color: ${THEME.tagText}; padding: 1px 6px; border-radius: 3px; text-transform: uppercase;`;
      cardHead.appendChild(catBadge);
    }

    if (place.rating) {
      const star = document.createElement('span');
      star.textContent = `★ ${place.rating}`;
      star.style.cssText = 'font-size: 11px; font-weight: 700; color: #b28600; margin-left: auto;';
      cardHead.appendChild(star);
    }
    card.appendChild(cardHead);

    const cardTitle = document.createElement('div');
    cardTitle.textContent = place.name;
    cardTitle.style.cssText = `font-size: 13px; font-weight: 700; color: ${THEME.textPrimary}; line-height: 1.3;`;
    card.appendChild(cardTitle);

    if (place.address) {
      const addrRow = document.createElement('div');
      addrRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; color: #525252;';
      const addrText = document.createElement('span');
      addrText.textContent = `📍 ${place.address}`;
      addrText.style.cssText = 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1;';
      addrRow.appendChild(addrText);

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.title = 'Copy address to clipboard';
      copyBtn.innerHTML = '📋';
      copyBtn.style.cssText = 'border: none; background: transparent; cursor: pointer; padding: 2px 4px; font-size: 11px;';
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (navigator.clipboard) {
          void navigator.clipboard.writeText(place.address || '');
          copyBtn.innerHTML = '✓';
          setTimeout(() => { copyBtn.innerHTML = '📋'; }, 1500);
        }
      });
      addrRow.appendChild(copyBtn);
      card.appendChild(addrRow);
    }

    if (place.description) {
      const desc = document.createElement('p');
      desc.textContent = place.description;
      desc.style.cssText = 'margin: 0; font-size: 11px; color: #6f6f6f; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;';
      card.appendChild(desc);
    }

    const cardFooter = document.createElement('div');
    cardFooter.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-top: auto; padding-top: 6px; border-top: 1px dashed #e0e0e0; gap: 6px;';

    const flyBtn = document.createElement('span');
    flyBtn.textContent = 'Focus Pin ➔';
    flyBtn.style.cssText = 'font-size: 11px; font-weight: 600; color: #0f62fe;';
    cardFooter.appendChild(flyBtn);

    const gmapsLink = document.createElement('a');
    gmapsLink.href = safeMapUrl(place.url, `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`);
    gmapsLink.target = '_blank';
    gmapsLink.rel = 'noopener noreferrer';
    gmapsLink.textContent = 'Directions ↗';
    gmapsLink.style.cssText = 'font-size: 11px; color: #525252; text-decoration: underline;';
    gmapsLink.addEventListener('click', (e) => e.stopPropagation());
    cardFooter.appendChild(gmapsLink);

    card.appendChild(cardFooter);
    cardElements.push(card);
    placeCardsWrap.appendChild(card);
  });

  // Guard for non-browser / headless runs
  if (typeof window === 'undefined') {
    return container;
  }

  // 5. Fullscreen Dialog Setup
  const dialog = document.createElement('dialog');
  dialog.className = 'interactive-map-dialog';
  dialog.style.cssText = `
    border: none;
    border-radius: 8px;
    padding: 0;
    max-width: 95vw;
    width: 1200px;
    height: 88vh;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
    background: #ffffff;
    overflow: hidden;
    position: relative;
  `;

  const modalHeader = document.createElement('div');
  modalHeader.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 18px;
    border-bottom: 1px solid #e0e0e0;
    background: #fbfbfb;
  `;

  const modalTitle = document.createElement('h3');
  modalTitle.textContent = spec.title || 'Interactive Map View';
  modalTitle.style.cssText = 'margin: 0; font-size: 15px; font-weight: 600; color: #161616;';
  modalHeader.appendChild(modalTitle);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.innerHTML = '&times; Close';
  closeBtn.style.cssText = `
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    padding: 4px 10px;
    background: #ffffff;
    cursor: pointer;
    font-weight: 600;
    font-size: 12px;
  `;
  modalHeader.appendChild(closeBtn);
  dialog.appendChild(modalHeader);
  container.appendChild(dialog);

  // 6. Map Initialization Logic
  let mapInstance: LeafletType.Map | null = null;
  const markers: LeafletType.Marker[] = [];
  let userMarker: LeafletType.Marker | null = null;
  const currentTileLayers: LeafletType.Layer[] = [];

  const highlightCard = (idx: number) => {
    cardElements.forEach((c, i) => {
      if (i === idx) {
        c.style.borderColor = THEME.primaryBlue;
        c.style.boxShadow = '0 0 0 2px #0f62fe';
        c.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest', inline: 'center' });
      } else {
        c.style.borderColor = THEME.border;
        c.style.boxShadow = 'none';
      }
    });
  };

  const focusPlace = (idx: number) => {
    if (!mapInstance || !places[idx]) return;
    const p = places[idx];
    mapInstance.flyTo([p.lat, p.lng], Math.max(mapInstance.getZoom(), 15), {
      duration: uiMotion.enter / 1000, animate: !prefersReducedMotion(),
    });
    markers[idx]?.openPopup();
    highlightCard(idx);
  };

  const fitAllMarkers = (L: typeof LeafletType) => {
    if (!mapInstance) return;
    const groupLayers: LeafletType.Layer[] = [...markers];
    if (userMarker) groupLayers.push(userMarker);
    if (groupLayers.length === 0) return;
    if (groupLayers.length === 1 && places.length > 0) {
      mapInstance.setView([places[0].lat, places[0].lng], spec.zoom || 14);
      return;
    }
    const group = L.featureGroup(groupLayers);
    mapInstance.fitBounds(group.getBounds().pad(0.18), { animate: !prefersReducedMotion(), duration: uiMotion.enter / 1000 });
  };

  const switchBasemap = async (styleKey: BasemapStyle) => {
    if (!mapInstance) return;
    const L = await getLeaflet();
    if (!L) return;

    activeStyle = styleKey;
    Object.keys(switcherButtons).forEach((k) => {
      const b = switcherButtons[k as BasemapStyle];
      if (k === styleKey) {
        b.style.background = '#0f62fe';
        b.style.color = '#ffffff';
      } else {
        b.style.background = 'transparent';
        b.style.color = THEME.textPrimary;
      }
    });

    currentTileLayers.forEach((layer) => {
      mapInstance?.removeLayer(layer);
    });
    currentTileLayers.length = 0;

    const cfg = BASEMAP_TILES[styleKey];
    cfg.layers.forEach((l) => {
      const tileLayer = L.tileLayer(l.url, l.options).addTo(mapInstance!);
      currentTileLayers.push(tileLayer);
    });
  };

  const initMap = async () => {
    if (mapInstance) return;
    const L = await getLeaflet();
    if (!L) return;

    let defaultCenter: [number, number] = spec.center || [places[0].lat, places[0].lng];
    if (!spec.center && places.length > 0) {
      const avgLat = places.reduce((sum, p) => sum + p.lat, 0) / places.length;
      const avgLng = places.reduce((sum, p) => sum + p.lng, 0) / places.length;
      defaultCenter = [avgLat, avgLng];
    }
    const defaultZoom = spec.zoom || (places.length === 1 ? 14 : 12);

    mapInstance = L.map(mapCanvasWrap, {
      center: defaultCenter,
      zoom: defaultZoom,
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,
    });

    // Apply default basemap (Esri Canvas Light Gray)
    await switchBasemap('canvas');

    // Create markers
    places.forEach((place, idx) => {
      const color = safeMapColor(place.color, PIN_PALETTE[idx % PIN_PALETTE.length]);
      const icon = createPinIcon(L, idx, color, false);
      const marker = L.marker([place.lat, place.lng], { icon }).addTo(mapInstance!);

      // Popup Content
      const popupDiv = document.createElement('div');
      popupDiv.style.cssText = `font-family: ${THEME.font}; padding: 6px 2px; max-width: 260px; color: ${THEME.textPrimary};`;

      const pTitle = document.createElement('h5');
      pTitle.textContent = place.name;
      pTitle.style.cssText = 'margin: 0 0 4px; font-size: 13px; font-weight: 700; line-height: 1.3; color: #161616;';
      popupDiv.appendChild(pTitle);

      const metaRow = document.createElement('div');
      metaRow.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap;';

      if (place.rating) {
        const ratingBadge = document.createElement('span');
        ratingBadge.style.cssText = 'font-size: 11px; font-weight: 700; color: #b28600; display: inline-flex; align-items: center; gap: 2px;';
        ratingBadge.textContent = `★ ${place.rating}`;
        metaRow.appendChild(ratingBadge);
      }

      if (place.category) {
        const catBadge = document.createElement('span');
        catBadge.textContent = place.category;
        catBadge.style.cssText = `font-size: 10px; font-weight: 600; background: ${THEME.tagBg}; color: ${THEME.tagText}; padding: 1px 6px; border-radius: 2px; text-transform: uppercase;`;
        metaRow.appendChild(catBadge);
      }
      popupDiv.appendChild(metaRow);

      if (place.address) {
        const addr = document.createElement('p');
        addr.textContent = `📍 ${place.address}`;
        addr.style.cssText = 'margin: 0 0 6px; font-size: 11px; color: #525252; line-height: 1.35;';
        popupDiv.appendChild(addr);
      }

      if (place.description) {
        const desc = document.createElement('p');
        desc.textContent = place.description;
        desc.style.cssText = 'margin: 0 0 8px; font-size: 11px; color: #6f6f6f; line-height: 1.35;';
        popupDiv.appendChild(desc);
      }

      const dirRow = document.createElement('div');
      dirRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-top: 6px; border-top: 1px solid #e0e0e0; padding-top: 6px;';

      const gDirLink = document.createElement('a');
      gDirLink.href = safeMapUrl(place.url, `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`);
      gDirLink.target = '_blank';
      gDirLink.rel = 'noopener noreferrer';
      gDirLink.textContent = 'Google Maps ↗';
      gDirLink.style.cssText = `font-size: 11px; font-weight: 600; color: ${THEME.primaryBlue}; text-decoration: none;`;
      dirRow.appendChild(gDirLink);

      const appleDirLink = document.createElement('a');
      appleDirLink.href = `https://maps.apple.com/?daddr=${place.lat},${place.lng}&q=${encodeURIComponent(place.name)}`;
      appleDirLink.target = '_blank';
      appleDirLink.rel = 'noopener noreferrer';
      appleDirLink.textContent = 'Apple Maps ↗';
      appleDirLink.style.cssText = 'font-size: 11px; color: #525252; text-decoration: underline;';
      dirRow.appendChild(appleDirLink);

      popupDiv.appendChild(dirRow);
      marker.bindPopup(popupDiv, { maxWidth: 280, className: 'carbon-map-popup' });

      marker.on('click', () => {
        highlightCard(idx);
      });

      markers.push(marker);

      const card = cardElements[idx];
      if (card) {
        card.addEventListener('click', () => {
          focusPlace(idx);
        });

        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            focusPlace(idx);
          }
        });
      }
    });

    fitAllMarkers(L);

    fitBtn.addEventListener('click', () => {
      fitAllMarkers(L);
    });

    // Style Switcher event listeners
    (['canvas', 'streets', 'satellite'] as BasemapStyle[]).forEach((styleKey) => {
      switcherButtons[styleKey].addEventListener('click', () => {
        void switchBasemap(styleKey);
      });
    });

    // Geolocation / Near Me handler
    nearMeBtn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser.');
        return;
      }
      nearMeBtn.innerHTML = '<span>⏳</span> Locating…';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          userCoords = [pos.coords.latitude, pos.coords.longitude];
          nearMeBtn.innerHTML = '<span>✓</span> Located';
          nearMeBtn.style.background = '#defbe6';
          nearMeBtn.style.borderColor = '#a7f0ba';

          if (userMarker) {
            userMarker.setLatLng(userCoords);
          } else {
            const userIcon = createUserLocationIcon(L);
            userMarker = L.marker(userCoords, { icon: userIcon, zIndexOffset: 2000 })
              .addTo(mapInstance!)
              .bindPopup('<strong>📍 You are here</strong>');
          }

          updateCardDistances();
          fitAllMarkers(L);
        },
        () => {
          nearMeBtn.innerHTML = '<span>⚠️</span> Location Denied';
          setTimeout(() => {
            nearMeBtn.innerHTML = '<span>📍</span> Near Me';
          }, 3000);
        },
        { timeout: 10000, enableHighAccuracy: true }
      );
    });

    // Real-time Search / Filter
    searchInput.addEventListener('input', () => {
      filterQuery = searchInput.value.toLowerCase().trim();
      let matchCount = 0;

      places.forEach((p, idx) => {
        const matches =
          !filterQuery ||
          p.name.toLowerCase().includes(filterQuery) ||
          (p.category || '').toLowerCase().includes(filterQuery) ||
          (p.address || '').toLowerCase().includes(filterQuery);

        const card = cardElements[idx];
        const marker = markers[idx];

        if (matches) {
          matchCount++;
          if (card) card.style.display = 'flex';
          if (marker && mapInstance && !mapInstance.hasLayer(marker)) {
            marker.addTo(mapInstance);
          }
        } else {
          if (card) card.style.display = 'none';
          if (marker && mapInstance && mapInstance.hasLayer(marker)) {
            mapInstance.removeLayer(marker);
          }
        }
      });

      filterStatus.textContent = `Showing ${matchCount} of ${places.length}`;
    });
  };

  // Maximize / Close Dialog functionality
  maximizeBtn.addEventListener('click', () => {
    dialog.append(mapCanvasWrap, searchRow, placeCardsWrap);
    mapCanvasWrap.style.height = 'calc(88vh - 160px)';
    mapCanvasWrap.style.minHeight = '380px';
    dialog.showModal();
    setTimeout(async () => {
      const L = await getLeaflet();
      mapInstance?.invalidateSize();
      if (L) fitAllMarkers(L);
    }, 120);
  });

  const restoreFromModal = () => {
    container.append(mapCanvasWrap, searchRow, placeCardsWrap);
    mapCanvasWrap.style.height = '380px';
    setTimeout(async () => {
      const L = await getLeaflet();
      mapInstance?.invalidateSize();
      if (L) fitAllMarkers(L);
    }, 120);
    maximizeBtn.focus();
  };

  closeBtn.addEventListener('click', () => {
    dialog.close();
  });

  dialog.addEventListener('close', () => {
    restoreFromModal();
  });

  dialog.addEventListener('click', (event) => {
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) {
      dialog.close();
    }
  });

  // IntersectionObserver to initialize map when card comes into view
  if (typeof IntersectionObserver !== 'undefined') {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            observer.disconnect();
            void initMap();
          }
        });
      },
      { threshold: 0.05 }
    );
    observer.observe(container);
  } else {
    setTimeout(initMap, 50);
  }

  return container;
}
