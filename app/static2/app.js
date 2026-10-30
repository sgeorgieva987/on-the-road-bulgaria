// Set window.OTR_API_BASE before this script when the static site is hosted
// separately (for example on GitHub Pages).
const API = window.OTR_API_BASE || '';
const tokenKey = 'otr_bulgaria_token';
let accessToken = localStorage.getItem(tokenKey) || sessionStorage.getItem(tokenKey) || '';
let currentUser = null;
let currentAccountMode = 'login';
let destinations = [];
let visibleCount = 8;
let selectedRoutePlaces = new Map();
let currentLatitude = null;
let currentLongitude = null;
let lastPlannerPayload = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function showToast(message) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function setStatus(id, message, isError = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message || '';
  el.style.color = isError ? '#b33939' : '';
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const isForm = options.body instanceof FormData;
  if (options.body && !isForm && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response;
  try {
    response = await fetch(`${API}${path}`, { ...options, headers });
  } catch (error) {
    throw new Error(`API сървърът не е достъпен. Стартирай приложението на http://127.0.0.1:8000 и опитай отново. (${error.message})`);
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.detail === 'string'
      ? data.detail
      : Array.isArray(data.detail)
        ? data.detail.map(item => `${item.loc?.join('.') || 'request'}: ${item.msg}`).join('; ')
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

// -------- GeoJSON loading + projection --------

function getAllRings(data) {
  if (data && data.type === 'FeatureCollection') {
    const rings = [];
    for (const feature of data.features || []) {
      if (!feature.geometry) continue;
      if (feature.geometry.type === 'Polygon') {
        rings.push(...feature.geometry.coordinates);
      } else if (feature.geometry.type === 'MultiPolygon') {
        for (const polygon of feature.geometry.coordinates) {
          rings.push(...polygon);
        }
      }
    }
    if (rings.length === 0) throw new Error('No polygon boundaries found in the GeoJSON file.');
    return rings;
  }
  if (data && data.type === 'Feature' && data.geometry) {
    if (data.geometry.type === 'Polygon') return data.geometry.coordinates;
    if (data.geometry.type === 'MultiPolygon') return data.geometry.coordinates.flat();
  }
  throw new Error(`Unsupported GeoJSON type: ${data && data.type}`);
}

let rings = [];
let project = () => ({ x: 0, y: 0 });
let createCountryPath = () => '';
const SVG_WIDTH = 1000;
const SVG_HEIGHT = 650;

async function initMapGeometry() {
  const res = await fetch(API ? `${API}/static/bulgaria.geojson` : './bulgaria.geojson');
  if (!res.ok) throw new Error(`GeoJSON load failed: ${res.status}`);
  const municipalitiesGeoJSON = await res.json();

  rings = getAllRings(municipalitiesGeoJSON);
  const allCoordinates = rings.flat();
  const longitudes = allCoordinates.map(([lon]) => lon);
  const latitudes = allCoordinates.map(([, lat]) => lat);

  const bounds = {
    minLon: Math.min(...longitudes),
    maxLon: Math.max(...longitudes),
    minLat: Math.min(...latitudes),
    maxLat: Math.max(...latitudes),
  };

  const MAP_PADDING = 45;
  const longitudeSpan = bounds.maxLon - bounds.minLon;
  const latitudeSpan = bounds.maxLat - bounds.minLat;
  const longitudeCorrection = Math.cos(((bounds.minLat + bounds.maxLat) / 2) * Math.PI / 180);

  const projectedWidth = longitudeSpan * longitudeCorrection;
  const projectedHeight = latitudeSpan;

  const scale = Math.min(
    (SVG_WIDTH - MAP_PADDING * 2) / projectedWidth,
    (SVG_HEIGHT - MAP_PADDING * 2) / projectedHeight
  );

  const drawnWidth = projectedWidth * scale;
  const drawnHeight = projectedHeight * scale;
  const offsetX = (SVG_WIDTH - drawnWidth) / 2;
  const offsetY = (SVG_HEIGHT - drawnHeight) / 2;

  project = (longitude, latitude) => ({
    x: offsetX + (longitude - bounds.minLon) * longitudeCorrection * scale,
    y: SVG_HEIGHT - offsetY - (latitude - bounds.minLat) * scale,
  });

  createCountryPath = () =>
    rings.map(ring =>
      ring.map(([lon, lat], i) => {
        const p = project(lon, lat);
        return `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
      }).join(' ') + ' Z'
    ).join(' ');
}

// -------- Rendering --------

function labelForCategory(destination) {
  const categories = destination.categories || [];
  const tags = destination.tags || [];
  if (categories.some(x => /природа|nature|hiking|геология/i.test(x))) return 'Природа';
  if (categories.some(x => /музей|археология|museum|archaeology/i.test(x))) return 'Археология';
  if (categories.some(x => /традиции|занаяти|crafts|food|wine|вино/i.test(x))) return 'Местни истории';
  if (tags.some(x => /по-малко познато/i.test(x))) return 'Скрита находка';
  return 'Култура и история';
}

function renderDestinationCard(d, index) {
  const category = labelForCategory(d);
  const tags = (d.tags || []).slice(0, 2).map(tag => `<span class="mini-tag">${escapeHtml(tag)}</span>`).join('');
  const review = d.verification_status === 'verified' ? '' : '<span class="status-tag">Чака проверка</span>';
  const isSelected = selectedRoutePlaces.has(Number(d.id));
  return `
    <article class="destination-card">
      <div class="destination-index">${String(index + 1).padStart(2, '0')}</div>
      <div class="destination-content">
        <h4>${escapeHtml(d.name)}</h4>
        <p>${escapeHtml(d.description || 'Няма добавено описание.')}</p>
        <div class="tag-row"><span class="mini-tag">${escapeHtml(category)}</span>${tags}${review}</div>
        <div class="card-actions">
          <button class="card-action" data-detail="${d.id}" type="button">Детайли ↗</button>
          <button class="card-action" data-route-add="${d.id}" type="button">${isSelected ? '✓ В маршрута' : '+ Добави към маршрута'}</button>
          <button class="card-action" data-save="${d.id}" type="button">${accessToken ? '♡ Запази' : '♡ Запази след вход'}</button>
        </div>
      </div>
    </article>
  `;
}

function updateMap(list) {
  const mapElement = $('#destinationMap');
  if (!mapElement) return;

  if (!rings.length) {
    mapElement.innerHTML = '<div class="map-error"><strong>Картата се зарежда…</strong></div>';
    return;
  }

  const markers = list
    .map((d) => {
      if (!Number.isFinite(Number(d.latitude)) || !Number.isFinite(Number(d.longitude))) return '';
      const point = project(Number(d.longitude), Number(d.latitude));
      const left = (point.x / SVG_WIDTH) * 100;
      const top = (point.y / SVG_HEIGHT) * 100;

      return `
        <button
          class="map-marker"
          style="left: ${left}%; top: ${top}%"
          data-place-id="${d.id}"
          aria-label="${escapeHtml(d.name)}"
          title="${escapeHtml(d.name)}"
          type="button"
        >
          <span>${d.type === 'restaurant' ? '🍴' : '🌿'}</span>
        </button>
      `;
    })
    .join('');

  mapElement.innerHTML = `
    <div class="bulgaria-map" style="position: relative; width: 100%; height: 100%; min-height: 400px;">
      <svg
        class="map-svg-bg"
        viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Географска карта на България"
        style="width: 100%; height: 100%; display: block;"
      >
        <defs>
          <linearGradient id="mapLandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#108a78" />
            <stop offset="100%" stop-color="#0e4c6f" />
          </linearGradient>
          <linearGradient id="mapFillGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#e6f4f0" />
            <stop offset="100%" stop-color="#cbe6dc" />
          </linearGradient>
        </defs>
        <path
          d="${createCountryPath()}"
          fill="url(#mapFillGrad)"
          stroke="url(#mapLandGrad)"
          stroke-width="1.2"
          stroke-linejoin="round"
          fill-rule="evenodd"
        />
      </svg>
      ${markers}
    </div>
  `;

  mapElement.querySelectorAll('.map-marker').forEach((marker) => {
    marker.addEventListener('click', () => {
      const placeId = marker.dataset.placeId;
      const found = destinations.find(item => String(item.id) === String(placeId));
      if (found) openDetail(found.id);
    });
  });
}

function renderSelectedRouteSummary() {
  const target = $('#selectedRouteSummary');
  if (!target) return;
  const placesArr = [...selectedRoutePlaces.values()];
  if (!placesArr.length) {
    target.innerHTML = '<span class="muted">Все още няма избрани места.</span>';
    return;
  }
  target.innerHTML = placesArr.map((place, index) => `
    <span class="selected-route-chip">
      <b>${index + 1}.</b> ${escapeHtml(place.name)}
      <button type="button" data-route-remove="${place.id}" aria-label="Премахни ${escapeHtml(place.name)}">×</button>
    </span>
  `).join('');
}

function toggleRouteDestination(destinationId) {
  const id = Number(destinationId);
  if (selectedRoutePlaces.has(id)) {
    selectedRoutePlaces.delete(id);
  } else {
    if (selectedRoutePlaces.size >= 9) { showToast('Можеш да добавиш до 9 места към един маршрут.'); return; }
    const place = destinations.find(item => Number(item.id) === id);
    if (!place) return;
    selectedRoutePlaces.set(id, place);
  }
  renderSelectedRouteSummary();
  renderList(destinations);
}

function renderList(list = destinations, count = visibleCount) {
  const slice = list.slice(0, count);
  const listContainer = $('#destinationList');
  if (listContainer) {
    listContainer.innerHTML = slice.length
      ? slice.map((d, i) => renderDestinationCard(d, i)).join('')
      : '<div class="archive-placeholder"><span>⌕</span><p>Няма намерени дестинации. Промени думата за търсене или премахни част от филтрите.</p></div>';
  }
  const countContainer = $('#resultsCount');
  if (countContainer) {
    countContainer.textContent = `Показани ${slice.length} от ${list.length} резултата`;
  }
  const loadMoreBtn = $('#loadMore');
  if (loadMoreBtn) {
    loadMoreBtn.classList.toggle('hidden', slice.length >= list.length || list.length === 0);
  }
  updateMap(list);
}

async function loadDestinations(reset = true) {
  if (reset) visibleCount = 8;
  const searchInput = $('#destinationSearch');
  const categoryFilter = $('#categoryFilter');
  const q = searchInput ? searchInput.value.trim() : '';
  const category = categoryFilter ? categoryFilter.value : '';

  const params = new URLSearchParams({ limit: '250' });
  if (q) params.set('q', q);
  if (category) params.set('category', category);

  setStatus('locationStatus', '');
  const listContainer = $('#destinationList');
  if (listContainer) {
    listContainer.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  }

  try {
    destinations = await api(`/api/destinations?${params.toString()}`);
    renderList(destinations);
    if (!destinations.length) setStatus('locationStatus', 'Не открихме съвпадения за тези филтри.');
  } catch (error) {
    if (listContainer) {
      listContainer.innerHTML = '<div class="archive-placeholder"><p>Не успяхме да заредим дестинациите. Провери дали API сървърът работи.</p></div>';
    }
    setStatus('locationStatus', error.message, true);
  }
}

// -------- Detail dialog --------

function openDetail(destinationId) {
  const d = destinations.find(item => item.id === Number(destinationId));
  if (!d) return;
  let dialog = $('#destinationDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'destinationDialog';
    dialog.className = 'account-dialog destination-dialog';
    document.body.appendChild(dialog);
  }
  const info = d.information || {};
  const practical = info.practical || {};
  const experience = info.experience || {};
  const decision = info.decision || {};
  const list = values => (values || []).filter(Boolean).map(value => `<li>${escapeHtml(value)}</li>`).join('');
  const cost = practical.cost_eur == null ? 'Провери цената' : `${escapeHtml(practical.cost_eur)} € ориентировъчно`;

  dialog.innerHTML = `
    <button class="dialog-close" aria-label="Затвори" type="button">×</button>
    <div class="eyebrow"><span class="eyebrow-line"></span> ${escapeHtml(d.region || 'БЪЛГАРИЯ')}</div>
    <h2>${escapeHtml(d.name)}</h2>
    <div class="tag-row">
      ${(d.categories || []).filter(x => /[А-Яа-я]/.test(x)).slice(0, 4).map(x => `<span class="mini-tag">${escapeHtml(x)}</span>`).join('')}
      <span class="status-tag">${d.verification_status === 'verified' ? 'Проверено' : 'Чака редакторска проверка'}</span>
    </div>
    <p class="dialog-intro">${escapeHtml(info.summary || d.description || '')}</p>
    <div class="detail-note">
      <b>Подходящо е, ако…</b>
      <ul>${list(info.good_for)}</ul>
      <p><strong>${escapeHtml(decision.best_for || '')}</strong> · трудност: ${escapeHtml(decision.difficulty || 'Провери на място')}</p>
    </div>
    ${info.highlights?.length ? `<div class="detail-note"><b>Какво ще видиш</b><ul>${list(info.highlights)}</ul></div>` : ''}
    <div class="detail-note">
      <b>Практично преди да тръгнеш</b>
      <ul>
        <li>Време за посещение: ${escapeHtml(practical.visit_minutes || d.estimated_visit_minutes || '—')} минути</li>
        <li>Цена: ${cost}</li>
        <li>Среда: ${escapeHtml(experience.terrain || 'Провери условията')}</li>
        <li>${escapeHtml(practical.access || 'Провери достъпа, работното време и сезонните ограничения.')}</li>
      </ul>
    </div>
    <div class="detail-note" id="detailSourceRefs"><b>Исторически източници</b><p>Проверяваме дали има свързани източници…</p></div>
    ${d.source_url ? `<p><a class="source-link" href="${escapeHtml(d.source_url)}" target="_blank" rel="noopener">Източник ↗</a></p>` : ''}
    <button class="btn btn-primary btn-full" data-dialog-save="${d.id}" type="button">♡ Запази мястото</button>
  `;

  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-dialog-save]').addEventListener('click', () => saveDestination(d.id));
  dialog.showModal();
  loadDestinationSources(d.id, dialog);
}

async function loadDestinationSources(destinationId, dialog) {
  const container = $('#detailSourceRefs', dialog);
  if (!container) return;
  try {
    const references = await api(`/api/destinations/${destinationId}/sources`);
    if (!references.length) {
      container.innerHTML = '<b>Исторически източници</b><p>Все още няма публикувани проверени източници за тази дестинация.</p>';
      return;
    }
    container.innerHTML = `<b>Исторически източници</b>${references.map(ref => `<p><strong>${escapeHtml(ref.source_title)}</strong> · ${escapeHtml(ref.author || 'Автор не е посочен')} · стр. ${escapeHtml(ref.page_number ?? '—')}<br>${escapeHtml(ref.excerpt || '')}${ref.source_url ? ` <a href="${escapeHtml(ref.source_url)}" target="_blank" rel="noopener">Източник ↗</a>` : ''}</p>`).join('')}`;
  } catch {
    container.innerHTML = '<b>Исторически източници</b><p>Информацията за източници в момента не е достъпна.</p>';
  }
}

async function saveDestination(destinationId) {
  if (!accessToken) {
    $('#accountDialog')?.showModal();
    setStatus('accountStatus', 'Влез или се регистрирай, за да запазваш места.');
    return;
  }
  try {
    await api(`/api/auth/me/saved-destinations/${destinationId}`, { method: 'POST' });
    showToast('Мястото е запазено в профила ти.');
  } catch (error) { showToast(error.message); }
}

// -------- Planner --------

function getSelectedPlannerInterests() {
  return $$('#plannerInterests input:checked').map(el => el.value);
}

function renderItinerary(data) {
  const emptyState = $('#itineraryEmpty');
  if (emptyState) emptyState.classList.add('hidden');
  const target = $('#itineraryResults');
  if (!target) return;
  target.classList.remove('hidden');
  const cost = data.estimated_total_cost_eur === null ? 'Неизвестна' : `€${Number(data.estimated_total_cost_eur).toFixed(0)}`;
  const stops = data.stops || [];

  target.innerHTML = `
    <div class="eyebrow"><span class="eyebrow-line"></span> ГОТОВ МАРШРУТ</div>
    <h3>${stops.length ? 'Твоята идея за път' : 'Промени параметрите'}</h3>
    <div class="itinerary-summary">
      <div class="itinerary-metric"><b>${Math.floor(data.estimated_total_minutes / 60)}ч ${data.estimated_total_minutes % 60}м</b><small>Път + посещения</small></div>
      <div class="itinerary-metric"><b>${Number(data.total_route_distance_km).toFixed(1)} км</b><small>Общо разстояние</small></div>
      <div class="itinerary-metric"><b>${cost}</b><small>Разходи за посещения</small></div>
    </div>
    ${stops.length ? stops.map(stop => `
      <article class="stop-card">
        <div class="stop-number">${stop.order}</div>
        <div class="stop-body">
          <h4>${escapeHtml(stop.destination.name)}</h4>
          <p>${escapeHtml(stop.destination.description || '')}</p>
          <div class="stop-details">
            <span>↗ ${stop.distance_from_previous_km} км до спирката</span>
            <span>◷ ${stop.travel_minutes_from_previous} мин път</span>
            <span>◎ ${stop.visit_minutes} мин посещение</span>
          </div>
        </div>
      </article>
    `).join('') : '<div class="archive-placeholder"><p>Нито една дестинация не се побира в този времеви и бюджетен лимит.</p></div>'}
    <div class="route-actions"><button class="btn btn-outline save-plan" id="savePlanButton" type="button">Запази маршрута в профила ↗</button>${data.google_maps_url ? `<a class="btn btn-primary" href="${escapeHtml(data.google_maps_url)}" target="_blank" rel="noopener">Отвори в Google Maps ↗</a>` : ''}</div>
  `;
  $('#savePlanButton')?.addEventListener('click', saveItinerary);
}

async function runPlanner(save = false) {
  const payload = lastPlannerPayload || plannerPayload();
  try {
    setStatus('plannerStatus', save ? 'Запазваме маршрута…' : 'Изчисляваме комбинация от спирки…');
    const query = save ? '?save=true&title=Маршрут%20в%20България' : '';
    const data = await api(`/api/itineraries/plan${query}`, { method: 'POST', body: JSON.stringify(payload) });
    if (!save) renderItinerary(data);
    setStatus('plannerStatus', '');
    if (save) showToast('Маршрутът е запазен в профила ти.');
  } catch (error) {
    setStatus('plannerStatus', error.message, true);
  }
}

async function saveItinerary() {
  if (!accessToken) {
    $('#accountDialog')?.showModal();
    setStatus('accountStatus', 'Влез, за да запазиш маршрута.');
    return;
  }
  await runPlanner(true);
}

// -------- Location, accounts, profile and archive --------

function setLocation(latitude, longitude, label = 'Местоположението ти е избрано.') {
  currentLatitude = Number(latitude);
  currentLongitude = Number(longitude);
  $('#startLat').value = currentLatitude;
  $('#startLon').value = currentLongitude;
  $('#plannerLocationLabel').textContent = label;
  $('#plannerLocationLabel').style.color = '';
}

function requestLocation({forPlanner = false} = {}) {
  if (!navigator.geolocation) {
    setLocation(42.6977, 23.3219, 'Местоположението не се поддържа. Използваме начална точка в София.');
    return;
  }
  const label = forPlanner ? $('#plannerLocationLabel') : $('#locationStatus');
  if (label) label.textContent = 'Изчакваме разрешение за местоположение…';
  navigator.geolocation.getCurrentPosition(
    position => {
      const {latitude, longitude} = position.coords;
      if (latitude < 41 || latitude > 44.3 || longitude < 22.3 || longitude > 28.7) {
        setLocation(42.6977, 23.3219, 'Местоположението е извън България. Използваме начална точка в София.');
        if (!forPlanner) setStatus('locationStatus', 'Местоположението е извън България.');
        return;
      }
      setLocation(latitude, longitude, 'Използваме текущото ти местоположение.');
      if (!forPlanner) loadDestinations(true);
    },
    () => {
      setLocation(42.6977, 23.3219, 'Няма разрешение. Използваме начална точка в София, без да показваме координати.');
      if (!forPlanner) setStatus('locationStatus', 'Няма разрешение за местоположение. Показваме всички дестинации.');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
  );
}

function plannerPayload() {
  const budgetText = $('#budget')?.value.trim() || '';
  const radiusText = $('#radius')?.value.trim() || '';
  const payload = {
    start_latitude: Number($('#startLat')?.value || 42.6977),
    start_longitude: Number($('#startLon')?.value || 23.3219),
    available_time_minutes: Number($('#timeBudget')?.value || 180),
    transport_mode: $('#transportMode')?.value || 'car',
    interests: getSelectedPlannerInterests(), include_unverified: $('#includeUnverified')?.checked ?? true,
    return_to_start: $('#returnToStart')?.checked ?? false, max_destinations: 5,
    selected_destination_ids: [...selectedRoutePlaces.keys()], remember_interests: $('#rememberTripInterests')?.checked ?? false,
  };
  if (budgetText) payload.budget_eur = Number(budgetText);
  if (radiusText) payload.radius_km = Number(radiusText);
  return payload;
}

function renderProfileLists(savedPlaces, savedRoutes) {
  const panel = $('#loggedInPanel');
  const dialog = $('#accountDialog');
  if (!panel || $('#profileSavedContent')) return;
  const section = document.createElement('div');
  section.id = 'profileSavedContent';
  section.innerHTML = `<div class="profile-saved"><h3>Запазени места</h3><div id="savedPlacesList">${savedPlaces.length ? savedPlaces.map(p => `<button type="button" class="text-btn saved-place" data-saved-place="${p.id}">${escapeHtml(p.name)} ↗</button>`).join('') : '<p class="muted">Все още няма запазени места.</p>'}</div><h3>Запазени маршрути</h3><div>${savedRoutes.length ? savedRoutes.map(r => `<article class="saved-route"><b>${escapeHtml(r.title)}</b><small>${r.estimated_total_minutes} минути · ${new Date(r.created_at).toLocaleDateString('bg-BG')}</small><button type="button" class="btn btn-outline" data-open-saved-route="${r.id}">Използвай маршрута</button></article>`).join('') : '<p class="muted">Все още няма запазени маршрути.</p>'}</div></div>`;
  panel.appendChild(section);
  section.addEventListener('click', e => {
    const place = e.target.closest('[data-saved-place]');
    if (place) { dialog?.close(); openDetail(Number(place.dataset.savedPlace)); }
    const route = e.target.closest('[data-open-saved-route]');
    if (route) loadSavedRoute(Number(route.dataset.openSavedRoute));
  });
}

async function loadProfile() {
  if (!accessToken) return;
  try {
    currentUser = await api('/api/auth/me');
    $('#profileLabel').textContent = currentUser.email;
    $('#accountForm').classList.add('hidden'); $('#loggedInPanel').classList.remove('hidden');
    $('#loggedInEmail').textContent = currentUser.email;
    const [places, routes, prefs] = await Promise.all([api('/api/auth/me/saved-destinations'), api('/api/itineraries/saved'), api('/api/auth/me/preferences')]);
    renderProfileLists(places, routes);
    $$('#preferencesForm input[type="checkbox"]').forEach(input => { input.checked = (prefs.interests || []).includes(input.value); });
    $('#prefTransport').value = prefs.preferred_transport || 'car'; $('#prefBudget').value = prefs.budget_eur ?? '';
  } catch { accessToken = ''; localStorage.removeItem(tokenKey); sessionStorage.removeItem(tokenKey); }
}

async function loadSavedRoute(id) {
  try {
    const saved = await api(`/api/itineraries/${id}`);
    lastPlannerPayload = saved.request_parameters;
    if (saved.request_parameters) {
      setLocation(saved.request_parameters.start_latitude, saved.request_parameters.start_longitude, 'Запазената начална точка е заредена.');
      selectedRoutePlaces.clear();
      (saved.destination_ids || []).forEach(id => { const place = destinations.find(d => d.id === id); if (place) selectedRoutePlaces.set(id, place); });
      renderSelectedRouteSummary(); renderList(destinations);
    }
    $('#accountDialog')?.close(); document.querySelector('#planner')?.scrollIntoView({behavior:'smooth'});
    showToast('Маршрутът е зареден. Натисни „Генерирай маршрут“, за да го видиш отново.');
  } catch (error) { showToast(error.message); }
}

function setAccountMode(mode) {
  currentAccountMode = mode;
  $$('.account-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.accountTab === mode));
  $('#accountSubmit').firstChild.textContent = mode === 'login' ? 'Вход ' : 'Регистрация ';
  $('#accountPassword').minLength = mode === 'register' ? 10 : 1;
}

async function submitAccount(event) {
  event.preventDefault();
  const email = $('#accountEmail').value.trim().toLowerCase(), password = $('#accountPassword').value;
  try {
    setStatus('accountStatus', 'Обработваме заявката…');
    const data = await api(`/api/auth/${currentAccountMode === 'login' ? 'login' : 'register'}`, {method:'POST', body: JSON.stringify({email, password})});
    accessToken = data.access_token; localStorage.setItem(tokenKey, accessToken); sessionStorage.setItem(tokenKey, accessToken);
    $('#accountEmail').value = ''; $('#accountPassword').value = ''; setStatus('accountStatus', ''); await loadProfile(); showToast('Профилът е готов.');
  } catch (error) { setStatus('accountStatus', error.message, true); }
}

async function submitPreferences(event) {
  event.preventDefault();
  try { await api('/api/auth/me/preferences', {method:'PUT', body: JSON.stringify({interests: $$('#preferencesForm input:checked').map(x => x.value), preferred_transport: $('#prefTransport').value, budget_eur: $('#prefBudget').value ? Number($('#prefBudget').value) : null})}); showToast('Предпочитанията са запазени.'); } catch (error) { showToast(error.message); }
}

async function searchArchive(event) {
  event.preventDefault(); const query = $('#archiveQuery').value.trim(); if (query.length < 2) return;
  try { setStatus('archiveStatus', 'Търсим…'); const rows = await api(`/api/sources/search?q=${encodeURIComponent(query)}`); $('#archiveResults').innerHTML = rows.length ? rows.map(r => `<article class="archive-result"><h3>${escapeHtml(r.source_title)}</h3><p>${escapeHtml(r.passage || '')}</p><small>стр. ${escapeHtml(r.page_number ?? '—')}</small></article>`).join('') : '<div class="archive-placeholder"><p>Няма намерени проверени откъси.</p></div>'; setStatus('archiveStatus', ''); } catch (error) { setStatus('archiveStatus', error.message, true); }
}

async function loadAdminSources() {
  try { const rows = await api('/api/admin/sources'); $('#adminSourcesList').innerHTML = rows.length ? rows.map(row => `<div class="admin-source-row"><b>${escapeHtml(row.title)}</b><small>${escapeHtml(row.processing_status)}</small></div>`).join('') : '<p class="muted">Няма качени източници.</p>'; } catch (error) { setStatus('sourceStatus', error.message, true); }
}

async function uploadSource(event) {
  event.preventDefault();
  try { setStatus('sourceStatus', 'Качваме и валидираме файла…'); await api('/api/admin/sources', {method:'POST', body: new FormData(event.currentTarget)}); event.currentTarget.reset(); setStatus('sourceStatus', 'Източникът е качен.'); loadAdminSources(); } catch (error) { setStatus('sourceStatus', error.message, true); }
}

// -------- Bootstrap --------

document.addEventListener('DOMContentLoaded', async () => {
  $('#year').textContent = new Date().getFullYear();
  await loadProfile();
  try {
    await initMapGeometry();
  } catch (err) {
    console.error('Map init failed:', err);
    const mapEl = $('#destinationMap');
    if (mapEl) {
      mapEl.innerHTML = `<div class="map-error"><strong>Картата не можа да се зареди</strong><span>${escapeHtml(err.message)}</span></div>`;
    }
  }

  loadDestinations(true);

  const searchInput = $('#destinationSearch');
  if (searchInput) {
    let searchTimer;
    searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadDestinations(true), 220); });
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); loadDestinations(true); } });
  }

  const categoryFilter = $('#categoryFilter');
  if (categoryFilter) {
    categoryFilter.addEventListener('change', () => loadDestinations(true));
  }

  const loadMoreBtn = $('#loadMore');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      visibleCount += 8;
      renderList(destinations, visibleCount);
    });
  }

  const destinationList = $('#destinationList');
  if (destinationList) {
    destinationList.addEventListener('click', (e) => {
      const detailBtn = e.target.closest('[data-detail]');
      if (detailBtn) { openDetail(detailBtn.dataset.detail); return; }
      const routeAddBtn = e.target.closest('[data-route-add]');
      if (routeAddBtn) { toggleRouteDestination(routeAddBtn.dataset.routeAdd); return; }
      const saveBtn = e.target.closest('[data-save]');
      if (saveBtn) { saveDestination(saveBtn.dataset.save); return; }
    });
  }

  const selectedRouteSummary = $('#selectedRouteSummary');
  if (selectedRouteSummary) {
    selectedRouteSummary.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('[data-route-remove]');
      if (removeBtn) toggleRouteDestination(removeBtn.dataset.routeRemove);
    });
  }

  const plannerForm = $('#plannerForm');
  if (plannerForm) {
    plannerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!$('#startLat').value || !$('#startLon').value) { requestLocation({forPlanner: true}); showToast('Разреши местоположението или натисни бутона отново, когато си готов.'); return; }
      lastPlannerPayload = plannerPayload();
      runPlanner(false);
    });
  }

  $('#plannerUseLocation')?.addEventListener('click', () => requestLocation({forPlanner: true}));
  $('#useLocation')?.addEventListener('click', () => requestLocation());
  $('#recommendationsButton')?.addEventListener('click', async () => {
    try {
      const rows = await api('/api/recommendations', {method:'POST', body: JSON.stringify({interests: getSelectedPlannerInterests(), latitude: currentLatitude, longitude: currentLongitude, include_unverified: true, limit: 250})});
      destinations = rows.map(row => row.destination); visibleCount = 8; renderList(destinations); setStatus('locationStatus', 'Показваме предложения според интересите ти.');
    } catch (error) { setStatus('locationStatus', error.message, true); }
  });
  $('#clearFilters')?.addEventListener('click', () => { $('#destinationSearch').value = ''; $('#categoryFilter').value = ''; loadDestinations(true); });
  $('#profileOpen')?.addEventListener('click', async () => { if (!accessToken) setAccountMode('login'); $('#accountDialog').showModal(); await loadProfile(); });
  $('#closeAccount')?.addEventListener('click', () => $('#accountDialog').close());
  $$('.account-tab').forEach(tab => tab.addEventListener('click', () => setAccountMode(tab.dataset.accountTab)));
  $('#accountForm')?.addEventListener('submit', submitAccount);
  $('#logoutButton')?.addEventListener('click', () => { accessToken = ''; currentUser = null; localStorage.removeItem(tokenKey); sessionStorage.removeItem(tokenKey); $('#loggedInPanel').classList.add('hidden'); $('#accountForm').classList.remove('hidden'); $('#profileLabel').textContent = 'Вход / Профил'; setStatus('accountStatus', 'Излезе от профила.'); });
  $('#showPreferences')?.addEventListener('click', () => $('#preferencesForm').classList.toggle('hidden'));
  $('#preferencesForm')?.addEventListener('submit', submitPreferences);
  $('#archiveSearchForm')?.addEventListener('submit', searchArchive);
  $('#loadSources')?.addEventListener('click', loadAdminSources);
  $('#uploadSourceForm')?.addEventListener('submit', uploadSource);
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); }));
  $('#mobileMenu')?.addEventListener('click', () => $('.main-nav')?.classList.toggle('open'));

  const clearRouteSelection = $('#clearRouteSelection');
  if (clearRouteSelection) {
    clearRouteSelection.addEventListener('click', () => {
      selectedRoutePlaces.clear();
      renderSelectedRouteSummary();
      renderList(destinations);
    });
  }
});
