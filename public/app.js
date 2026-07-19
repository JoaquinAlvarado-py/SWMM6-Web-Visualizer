// app.js — Map initialization, network rendering, 3D extras,
// INP import flow, WASM simulation run.

(function () {
    'use strict';

    const DEFAULT_CENTER = [-71.254, -29.908]; // La Serena, Chile
    const DEFAULT_ZOOM = 15.2;

    if (typeof CONFIG !== 'undefined') {
        mapboxgl.accessToken = CONFIG.MAPBOX_ACCESS_TOKEN;
    } else {
        console.error('config.js missing! Mapbox features may fail.');
    }

    const MAP_STYLES = {
        streets: 'mapbox://styles/mapbox/streets-v12',
        satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
        blank: {
            version: 8,
            glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
            sources: {},
            layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f8f9fa' } }]
        }
    };

    const map = new mapboxgl.Map({
        container: 'map',
        style: MAP_STYLES.streets,
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        pitch: 0,
        bearing: 0,
        antialias: true,
        boxZoom: false
    });

    window.map = map; // for street_view_overlay.js and other modules

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(new mapboxgl.ScaleControl({ maxWidth: 120 }), 'bottom-left');

    // ---------- App-wide state ----------
    window.App = {
        map: map,
        currentStyle: 'streets',
        labelsVisible: true,
        is3D: false,
        selection: new Set(),      // selected element ids
        masterPlan: null,          // geojson reference overlay
        lastRunReport: null
    };

    // ---------- SWMM element colors (EPA SWMM-like conventions) ----------
    const NODE_COLORS = {
        JUNCTION: '#1565c0',
        OUTFALL: '#2e7d32',
        STORAGE: '#6a1b9a',
        DIVIDER: '#ef6c00',
        RAINGAGE: '#00838f'
    };
    const LINK_COLORS = {
        CONDUIT: '#455a64',
        PUMP: '#c62828',
        WEIR: '#ad1457',
        ORIFICE: '#4527a0'
    };
    window.SWMM_COLORS = { NODE_COLORS, LINK_COLORS };

    const nodeColorExpr = ['match', ['get', 'type'],
        'OUTFALL', NODE_COLORS.OUTFALL,
        'STORAGE', NODE_COLORS.STORAGE,
        'DIVIDER', NODE_COLORS.DIVIDER,
        'RAINGAGE', NODE_COLORS.RAINGAGE,
        NODE_COLORS.JUNCTION];

    const linkColorExpr = ['match', ['get', 'type'],
        'PUMP', LINK_COLORS.PUMP,
        'WEIR', LINK_COLORS.WEIR,
        'ORIFICE', LINK_COLORS.ORIFICE,
        LINK_COLORS.CONDUIT];

    const selectedCase = (sel, hov, base) => ['case',
        ['boolean', ['feature-state', 'selected'], false], sel,
        ['boolean', ['feature-state', 'hovered'], false], hov,
        base];

    // simulation results override element colors when present
    const resultOr = (base) => ['case',
        ['!=', ['feature-state', 'resultColor'], null], ['feature-state', 'resultColor'],
        base];

    // ---------- Network layers ----------
    function ensureNetworkLayers() {
        // Draft (in-progress drawing) source
        if (!map.getSource('draft')) {
            map.addSource('draft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        }

        if (!map.getSource('swmm-2d-mesh')) {
            map.addSource('swmm-2d-mesh', { type: 'geojson', promoteId: 'id', data: Net.mesh2DGeoJSON() });
            map.addLayer({
                id: 'swmm-2d-mesh-fill',
                type: 'fill',
                source: 'swmm-2d-mesh',
                paint: {
                    'fill-color': resultOr('#90caf9'),
                    'fill-opacity': selectedCase(0.7, 0.6, 0.4)
                }
            });
            map.addLayer({
                id: 'swmm-2d-mesh-line',
                type: 'line',
                source: 'swmm-2d-mesh',
                paint: {
                    'line-color': '#1565c0',
                    'line-width': 1,
                    'line-opacity': 0.5
                }
            });
        }

        if (!map.getSource('swmm-subcatchments')) {
            map.addSource('swmm-subcatchments', { type: 'geojson', promoteId: 'id', data: Net.subcatchmentsGeoJSON() });
            map.addLayer({
                id: 'swmm-subcatchments-fill',
                type: 'fill',
                source: 'swmm-subcatchments',
                paint: {
                    'fill-color': '#66bb6a',
                    'fill-opacity': selectedCase(0.55, 0.45, 0.3)
                }
            });
            map.addLayer({
                id: 'swmm-subcatchments-line',
                type: 'line',
                source: 'swmm-subcatchments',
                paint: {
                    'line-color': '#2e7d32',
                    'line-width': selectedCase(3, 2.5, 1.5),
                    'line-dasharray': [4, 2]
                }
            });
        }

        if (!map.getSource('swmm-links')) {
            map.addSource('swmm-links', { type: 'geojson', promoteId: 'id', data: Net.linksGeoJSON() });
            // wide invisible hit area for easier clicking
            map.addLayer({
                id: 'swmm-links-hit',
                type: 'line',
                source: 'swmm-links',
                paint: { 'line-color': '#000', 'line-opacity': 0.001, 'line-width': 14 }
            });
            map.addLayer({
                id: 'swmm-links-layer',
                type: 'line',
                source: 'swmm-links',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': selectedCase('#ffab00', '#42a5f5', resultOr(linkColorExpr)),
                    'line-width': selectedCase(5, 4.5, 3)
                }
            });
            // flow-direction arrows
            map.addLayer({
                id: 'swmm-links-arrows',
                type: 'symbol',
                source: 'swmm-links',
                layout: {
                    'symbol-placement': 'line',
                    'symbol-spacing': 80,
                    'text-field': '>',
                    'text-size': 12,
                    'text-keep-upright': false,
                    'text-allow-overlap': true,
                    'text-rotation-alignment': 'map'
                },
                paint: { 'text-color': selectedCase('#ffab00', '#42a5f5', resultOr(linkColorExpr)) }
            });
        }

        if (!map.getSource('swmm-nodes')) {
            map.addSource('swmm-nodes', { type: 'geojson', promoteId: 'id', data: Net.nodesGeoJSON() });
            map.addLayer({
                id: 'swmm-nodes-layer',
                type: 'circle',
                source: 'swmm-nodes',
                paint: {
                    'circle-radius': selectedCase(9, 8, 6),
                    'circle-color': resultOr(nodeColorExpr),
                    'circle-stroke-width': selectedCase(3, 2.5, 1.5),
                    'circle-stroke-color': selectedCase('#ffab00', '#90caf9', '#ffffff')
                }
            });
            map.addLayer({
                id: 'swmm-nodes-labels',
                type: 'symbol',
                source: 'swmm-nodes',
                minzoom: 14,
                layout: {
                    'text-field': ['get', 'id'],
                    'text-size': 10,
                    'text-offset': [0, 1.3],
                    'text-anchor': 'top',
                    'text-optional': true
                },
                paint: {
                    'text-color': '#1f2933',
                    'text-halo-color': '#ffffff',
                    'text-halo-width': 1.5
                }
            });
        }

        // Draft layers on top
        if (!map.getLayer('draft-line')) {
            map.addLayer({
                id: 'draft-line',
                type: 'line',
                source: 'draft',
                filter: ['==', ['geometry-type'], 'LineString'],
                paint: { 'line-color': '#1565c0', 'line-width': 2.5, 'line-dasharray': [2, 2] }
            });
            map.addLayer({
                id: 'draft-fill',
                type: 'fill',
                source: 'draft',
                filter: ['==', ['geometry-type'], 'Polygon'],
                paint: { 'fill-color': '#1565c0', 'fill-opacity': 0.15 }
            });
            map.addLayer({
                id: 'draft-points',
                type: 'circle',
                source: 'draft',
                filter: ['==', ['geometry-type'], 'Point'],
                paint: {
                    'circle-radius': 4, 'circle-color': '#1565c0',
                    'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff'
                }
            });
        }

        // Master plan overlay
        if (window.App.masterPlan && !map.getSource('master-plan')) {
            addMasterPlanLayers(window.App.masterPlan);
        }

        applyResultStylingIfAny();
    }

    function refreshNetworkData() {
        const nodesSrc = map.getSource('swmm-nodes');
        if (!nodesSrc) return;
        nodesSrc.setData(Net.nodesGeoJSON());
        map.getSource('swmm-links').setData(Net.linksGeoJSON());
        map.getSource('swmm-subcatchments').setData(Net.subcatchmentsGeoJSON());
        const meshSrc = map.getSource('swmm-2d-mesh');
        if (meshSrc) meshSrc.setData(Net.mesh2DGeoJSON());
        // restore selection feature-state
        window.App.selection.forEach(id => setElementState(id, { selected: true }));
    }
    window.refreshNetworkData = refreshNetworkData;

    // Incremental refresh for node moves: Net patches its cached GeoJSON in
    // place, so we only re-send the nodes + links sources (subcatchments and
    // mesh are untouched by a move). Throttled to one setData per rAF so
    // dragging costs at most ~60 updates/s regardless of mousemove rate.
    let moveRefreshQueued = false;
    function refreshNetworkDataForMove() {
        if (moveRefreshQueued) return;
        moveRefreshQueued = true;
        requestAnimationFrame(() => {
            moveRefreshQueued = false;
            const nodesSrc = map.getSource('swmm-nodes');
            if (!nodesSrc) return;
            nodesSrc.setData(Net.nodesGeoJSON());
            map.getSource('swmm-links').setData(Net.linksGeoJSON());
        });
    }

    function sourceForId(id) {
        if (Net.getNode(id)) return 'swmm-nodes';
        if (Net.getLink(id)) return 'swmm-links';
        if (Net.getSubcatchment(id)) return 'swmm-subcatchments';
        if (Net.mesh2D && Net.mesh2D.find(m => m.id === id)) return 'swmm-2d-mesh';
        return null;
    }

    function setElementState(id, state) {
        const src = sourceForId(id);
        if (!src || !map.getSource(src)) return;
        try { map.setFeatureState({ source: src, id: id }, state); } catch (e) { /* source not ready */ }
    }
    window.setElementState = setElementState;

    // ---------- Master plan overlay ----------
    function addMasterPlanLayers(geojson) {
        map.addSource('master-plan', { type: 'geojson', data: geojson });
        map.addLayer({
            id: 'master-plan-fill', type: 'fill', source: 'master-plan',
            filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
            paint: { 'fill-color': '#9e9e9e', 'fill-opacity': 0.15 }
        }, 'swmm-subcatchments-fill');
        map.addLayer({
            id: 'master-plan-line', type: 'line', source: 'master-plan',
            filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'MultiLineString'],
                     ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
            paint: { 'line-color': '#757575', 'line-width': 1.2, 'line-opacity': 0.7 }
        }, 'swmm-subcatchments-fill');
        map.addLayer({
            id: 'master-plan-points', type: 'circle', source: 'master-plan',
            filter: ['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']],
            paint: { 'circle-radius': 3, 'circle-color': '#757575', 'circle-opacity': 0.7 }
        }, 'swmm-subcatchments-fill');
    }

    window.setMasterPlan = function (geojson) {
        window.App.masterPlan = geojson;
        ['master-plan-fill', 'master-plan-line', 'master-plan-points'].forEach(l => {
            if (map.getLayer(l)) map.removeLayer(l);
        });
        if (map.getSource('master-plan')) map.removeSource('master-plan');
        if (geojson) addMasterPlanLayers(geojson);
    };

    // ---------- 3D extras (terrain + buildings) ----------
    function apply3D() {
        if (window.App.is3D) {
            if (window.App.currentStyle !== 'blank') {
                if (!map.getSource('terrain-dem')) {
                    map.addSource('terrain-dem', {
                        type: 'raster-dem',
                        url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
                        tileSize: 512, maxzoom: 14
                    });
                }
                map.setTerrain({ source: 'terrain-dem', exaggeration: 1.3 });
                add3DBuildings();
            }
            if (map.getPitch() < 30) map.easeTo({ pitch: 55, duration: 800 });
        } else {
            map.setTerrain(null);
            if (map.getLayer('3d-buildings-base')) map.setLayoutProperty('3d-buildings-base', 'visibility', 'none');
            map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
        }
    }
    window.apply3D = apply3D;

    function add3DBuildings() {
        if (map.getLayer('3d-buildings-base')) {
            map.setLayoutProperty('3d-buildings-base', 'visibility', 'visible');
            return;
        }
        if (!map.getSource('composite')) return;
        const layers = map.getStyle().layers;
        let labelLayerId = null;
        for (const l of layers) {
            if (l.type === 'symbol' && l.layout && l.layout['text-field']) { labelLayerId = l.id; break; }
        }
        map.addLayer({
            id: '3d-buildings-base',
            source: 'composite',
            'source-layer': 'building',
            filter: ['==', 'extrude', 'true'],
            type: 'fill-extrusion',
            minzoom: 14,
            paint: {
                'fill-extrusion-color': '#e2e8f0',
                'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 15],
                'fill-extrusion-opacity': 0.75
            }
        }, labelLayerId);
    }

    // ---------- Labels toggle ----------
    function applyLabelsVisibility() {
        const vis = window.App.labelsVisible ? 'visible' : 'none';
        map.getStyle().layers.forEach(l => {
            if (l.type === 'symbol' && l.id !== 'swmm-nodes-labels' && l.id !== 'swmm-links-arrows') {
                try { map.setLayoutProperty(l.id, 'visibility', vis); } catch (e) { }
            }
        });
    }
    window.applyLabelsVisibility = applyLabelsVisibility;

    // ---------- Style switching ----------
    window.setMapStyle = function (styleKey) {
        window.App.currentStyle = styleKey;
        map.setStyle(MAP_STYLES[styleKey]);
        // network layers re-added on style.load
    };

    map.on('style.load', () => {
        ensureNetworkLayers();
        applyLabelsVisibility();
        apply3D();
    });

    // ---------- React to model changes ----------
    Net.onChange((net, evt) => {
        // node drags fire 'move' at mouse rate — do a cheap incremental update
        if (evt && evt.type === 'move') {
            refreshNetworkDataForMove();
        } else {
            refreshNetworkData();
        }
        if (window.updateUICounts) window.updateUICounts();
    });

    // ---------- Coordinates readout in status bar ----------
    map.on('mousemove', (e) => {
        const el = document.getElementById('sb-coords');
        if (el) el.textContent = `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`;
    });

    // ---------- Fit view to network ----------
    window.fitToNetwork = function () {
        const coords = Net.bounds();
        if (!coords || !coords.length) return;
        const validCoords = coords.filter(c => c && c.length >= 2 && !isNaN(c[0]) && !isNaN(c[1]));
        if (!validCoords.length) return;
        const bounds = validCoords.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(validCoords[0], validCoords[0]));
        map.fitBounds(bounds, { padding: 80, duration: 1200, maxZoom: 17 });
    };

    // INP import flow (projection modal → parser → model)
    const projectionModal = document.getElementById('projection-modal');
    const utmOptions = document.getElementById('utm-options');
    const localOptions = document.getElementById('local-options');
    const epsgCodeInput = document.getElementById('epsg-code-input');

    let pendingImportModel = null; // parsed model awaiting projection choice

    document.querySelectorAll('input[name="coord-type"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            utmOptions.classList.toggle('hidden', e.target.value !== 'utm');
            localOptions.classList.toggle('hidden', e.target.value !== 'local');
        });
    });

    document.getElementById('btn-cancel-proj').addEventListener('click', () => {
        projectionModal.classList.add('hidden');
        pendingImportModel = null;
    });

    document.getElementById('btn-confirm-proj').addEventListener('click', async () => {
        projectionModal.classList.add('hidden');
        if (!pendingImportModel) return;
        const coordType = document.querySelector('input[name="coord-type"]:checked').value;
        const epsgCode = epsgCodeInput.value.trim() || 'EPSG:32719';
        await applyProjectionAndLoad(pendingImportModel, coordType, epsgCode);
        pendingImportModel = null;
    });

    window.openProjectionModal = function (model) {
        pendingImportModel = model;
        projectionModal.classList.remove('hidden');
    };

    async function fetchProjDef(epsgCode) {
        const code = epsgCode.split(':')[1];
        if (!code) return null;
        try {
            const res = await fetch(`https://epsg.io/${code}.proj4`);
            if (res.ok) return await res.text();
        } catch (err) {
            console.warn('Failed to fetch proj4 definition', err);
        }
        return null;
    }

    function transformModelCoords(model, fn) {
        model.nodes.forEach(n => { n.lngLat = fn(n.lngLat); });
        model.links.forEach(l => { l.vertices = (l.vertices || []).map(fn); });
        model.subcatchments.forEach(s => { s.ring = s.ring.map(fn); });
    }

    function normalizeLocalCoords(model) {
        // Scale/center arbitrary local coordinates near the current map view
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const scan = (c) => {
            if (c[0] < minX) minX = c[0];
            if (c[0] > maxX) maxX = c[0];
            if (c[1] < minY) minY = c[1];
            if (c[1] > maxY) maxY = c[1];
        };
        model.nodes.forEach(n => scan(n.lngLat));
        model.subcatchments.forEach(s => s.ring.forEach(scan));
        if (!isFinite(minX)) return;

        const center = map.getCenter();
        const rangeX = maxX - minX || 1;
        const rangeY = maxY - minY || 1;
        const scale = 0.02 / Math.max(rangeX, rangeY);
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        transformModelCoords(model, c => [
            center.lng + (c[0] - cx) * scale,
            center.lat + (c[1] - cy) * scale
        ]);
    }

    async function applyProjectionAndLoad(model, coordType, epsgCode) {
        if (coordType === 'utm' && window.proj4) {
            const projDef = await fetchProjDef(epsgCode);
            if (projDef) proj4.defs(epsgCode, projDef);
            try {
                transformModelCoords(model, c => proj4(epsgCode, 'EPSG:4326', [c[0], c[1]]));
            } catch (e) {
                alert('Reprojection failed: ' + e.message + '\nLoading raw coordinates.');
            }
        } else if (coordType === 'local') {
            normalizeLocalCoords(model);
        }

        window.loadModelIntoNetwork(model);
    }

    // Load a parsed model (from INP / importers) into the live Network
    window.loadModelIntoNetwork = function (model, merge = false) {
        if (!merge) {
            const state = {
                title: model.title || 'Imported SWMM Project',
                units: model.units || 'SI',
                options: Object.assign({}, Net.options, model.options || {}),
                counters: {},
                nodes: model.nodes || [],
                links: model.links || [],
                subcatchments: model.subcatchments || [],
                rawSections: model.rawSections || {}
            };
            Net.loadState(state, true);
        } else {
            // merge: add with fresh unique ids when colliding
            // (register in the index maps as we go so findAny sees them)
            (model.nodes || []).forEach(n => {
                if (Net.findAny(n.id)) n.id = Net.nextId(n.type);
                Net.nodes.push(n);
                Net._nodeMap.set(n.id, n);
            });
            (model.links || []).forEach(l => {
                if (Net.findAny(l.id)) l.id = Net.nextId(l.type);
                Net.links.push(l);
                Net._linkMap.set(l.id, l);
            });
            (model.subcatchments || []).forEach(s => {
                if (Net.findAny(s.id)) s.id = Net.nextId('SUBCATCHMENT');
                Net.subcatchments.push(s);
                Net._subMap.set(s.id, s);
            });
            Net.commit();
            Net.emit('bulk');
        }
        window.clearSelection && window.clearSelection();
        setTimeout(() => window.fitToNetwork(), 100);
    };

    // WASM simulation run
    let swmmModulePromise = null;
    function getSwmmModule() {
        if (!swmmModulePromise) {
            if (typeof createModule === 'undefined') {
                return Promise.reject(new Error('SWMM WASM engine not found (swmmwasm.js missing).'));
            }
            // Pass noInitialRun: true so it doesn't crash trying to call main() on load
            swmmModulePromise = createModule({
                noInitialRun: true,
                print: (text) => console.log('SWMM:', text),
                printErr: (text) => console.warn('SWMM Err:', text)
            });
        }
        return swmmModulePromise;
    }

    // ---------- loading overlay (parsing / simulation progress) ----------
    let loadingOverlayEl = null;
    window.showLoadingOverlay = function (title, stage) {
        if (!loadingOverlayEl) {
            loadingOverlayEl = document.createElement('div');
            loadingOverlayEl.id = 'loading-overlay';
            Object.assign(loadingOverlayEl.style, {
                position: 'fixed', inset: '0', zIndex: '9999',
                background: 'rgba(15, 23, 42, 0.55)', display: 'flex',
                alignItems: 'center', justifyContent: 'center'
            });
            loadingOverlayEl.innerHTML = `
                <div style="background:#fff;border-radius:10px;padding:22px 30px;min-width:280px;
                            box-shadow:0 10px 40px rgba(0,0,0,.3);text-align:center;font-family:inherit">
                    <div id="loading-overlay-title" style="font-weight:600;margin-bottom:10px"></div>
                    <div style="height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;margin-bottom:8px">
                        <div id="loading-overlay-bar" style="height:100%;width:10%;background:#1565c0;
                             border-radius:3px;transition:width .3s"></div>
                    </div>
                    <div id="loading-overlay-stage" style="font-size:12px;color:#64748b"></div>
                </div>`;
            document.body.appendChild(loadingOverlayEl);
        }
        loadingOverlayEl.style.display = 'flex';
        document.getElementById('loading-overlay-title').textContent = title || 'Working…';
        document.getElementById('loading-overlay-stage').textContent = stage || '';
        document.getElementById('loading-overlay-bar').style.width = '10%';
    };
    window.updateLoadingOverlay = function (pct, stage) {
        if (!loadingOverlayEl) return;
        if (pct != null) document.getElementById('loading-overlay-bar').style.width = Math.max(2, Math.min(100, pct)) + '%';
        if (stage) document.getElementById('loading-overlay-stage').textContent = stage;
    };
    window.hideLoadingOverlay = function () {
        if (loadingOverlayEl) loadingOverlayEl.style.display = 'none';
    };

    // ---------- .inp parsing in a Web Worker ----------
    // Falls back to synchronous inpParser.parse() when workers are unavailable
    // (e.g. when the app is opened from file://).
    window.parseInpAsync = function (text) {
        return new Promise((resolve, reject) => {
            let worker = null;
            try {
                worker = new Worker('parseWorker.js');
            } catch (e) {
                try { resolve(window.inpParser.parse(text)); }
                catch (err) { reject(err); }
                return;
            }
            worker.onmessage = (ev) => {
                const msg = ev.data || {};
                if (msg.type === 'progress') {
                    window.updateLoadingOverlay(msg.pct, msg.stage);
                } else if (msg.type === 'done') {
                    worker.terminate();
                    resolve(msg.model);
                } else if (msg.type === 'error') {
                    worker.terminate();
                    reject(new Error(msg.message));
                }
            };
            worker.onerror = () => {
                // worker failed to boot (CSP, file://, …) — parse on main thread
                worker.terminate();
                try { resolve(window.inpParser.parse(text)); }
                catch (err) { reject(err); }
            };
            worker.postMessage({ text });
        });
    };

    // ---------- simulation in a Web Worker ----------
    function runSimulationInWorker(inpText) {
        return new Promise((resolve, reject) => {
            let worker = null;
            try {
                worker = new Worker('simWorker.js');
            } catch (e) {
                reject(e); // caller falls back to main-thread run
                return;
            }
            worker.onmessage = (ev) => {
                const msg = ev.data || {};
                if (msg.type === 'log') { console.log('SWMM:', msg.text); }
                else if (msg.type === 'err') { console.warn('SWMM Err:', msg.text); }
                else if (msg.type === 'done') {
                    worker.terminate();
                    resolve({ rpt: msg.rpt, outBuffer: msg.outBuffer });
                } else if (msg.type === 'error') {
                    worker.terminate();
                    reject(new Error(msg.message));
                }
            };
            worker.onerror = (e) => {
                worker.terminate();
                reject(new Error(e.message || 'Simulation worker failed to start.'));
            };
            worker.postMessage({ type: 'run', inpText });
        });
    }

    // Main-thread fallback (previous behavior) for environments without workers
    async function runSimulationOnMainThread(inpText) {
        const Module = await getSwmmModule();
        // let the UI paint before the synchronous run blocks the thread
        await new Promise(r => setTimeout(r, 50));

        Module.FS.writeFile('/in.inp', inpText);
        try {
            let ran = false;

            // Try callMain first since it's the standard Emscripten way now
            if (typeof Module.callMain === 'function') {
                console.log('Running via callMain');
                Module.callMain(['/in.inp', '/rpt.rpt', '/out.out']);
                ran = true;
            } else {
                // Safely check for ccall to avoid getter aborts in newer Emscripten
                let hasCCall = false;
                try { hasCCall = typeof Module.ccall === 'function'; } catch (e) { }

                if (hasCCall && typeof Module._swmm_run === 'function') {
                    console.log('Running via ccall(swmm_run)');
                    Module.ccall('swmm_run', 'number', ['string', 'string', 'string'], ['/in.inp', '/rpt.rpt', '/out.out']);
                    ran = true;
                } else if (typeof Module.run === 'function') {
                    console.log('Running via run (fallback)');
                    Module.run(['/in.inp', '/rpt.rpt', '/out.out']);
                    ran = true;
                }
            }

            if (!ran) {
                throw new Error('No entry point found in SWMM WebAssembly module.');
            }

        } catch (e) {
            // Emscripten's exit() throws — a report may still exist
            console.warn('SWMM engine exit:', e);
        }

        let rpt = '';
        try {
            rpt = Module.FS.readFile('/rpt.rpt', { encoding: 'utf8' });
        } catch (err) {
            throw new Error('Simulation produced no report file.');
        }

        let outBuffer = null;
        try {
            const outBytes = Module.FS.readFile('/out.out');
            outBuffer = outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength);
        } catch (err) {
            console.warn('Simulation produced no binary .out file.');
        }
        return { rpt, outBuffer };
    }

    window.runSimulation = async function () {
        const btnRun = document.getElementById('btn-run');
        if (Net.nodeCount === 0) {
            window.showResultsWarning('Build a network with at least one node before running.');
            return;
        }
        if (!Net.nodes.some(n => n.type === 'OUTFALL')) {
            window.showResultsWarning('The network needs at least one outfall node.');
            return;
        }

        const inpText = window.inpExporter.generateInp(Net);
        btnRun.disabled = true;
        btnRun.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg> Running…';

        try {
            let result;
            try {
                // Preferred: run in a worker so the UI stays interactive
                result = await runSimulationInWorker(inpText);
            } catch (workerErr) {
                console.warn('Simulation worker unavailable, running on main thread:', workerErr);
                result = await runSimulationOnMainThread(inpText);
            }

            const { rpt, outBuffer } = result;

            if (outBuffer && window.SWMMOutParser) {
                const outParser = new window.SWMMOutParser(outBuffer);
                outParser.parse();
                window.App.outData = outParser;
            } else {
                window.App.outData = null;
            }

            window.App.lastRunReport = rpt;
            console.log(rpt);
            window.displayResults(rpt, window.App.outData);
        } catch (err) {
            console.error('Simulation failed:', err);
            window.showResultsWarning('Simulation failed: ' + err.message);
        } finally {
            btnRun.disabled = false;
            btnRun.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8 5v14l11-7z"/></svg> Run';
        }
    };

    // ---------- results styling hook (results.js sets window.ResultStyling) ----------
    function applyResultStylingIfAny() {
        if (window.ResultStyling && window.ResultStyling.active) {
            window.ResultStyling.applyToMap();
        }
    }
})();
