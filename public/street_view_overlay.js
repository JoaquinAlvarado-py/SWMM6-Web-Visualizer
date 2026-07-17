/**
 * street_view_overlay.js (Mapbox GL JS adaptation)
 *
 * Adds Google Street View with an HTML Canvas overlay that projects Mapbox vector layers
 * using Google Elevation API for terrain correction.
 */

(function () {
    'use strict';

    // Configuration
    const MAX_DIST_M = 150;     // metres — max distance to render a vertex
    const DENSIFY_STEP_M = 5;   // metres — max spacing between densified points
    const CAM_HEIGHT = 2.5;     // metres — standard SV camera height above ground
    const MOVE_THRESH_M = 3;    // metres — min Pegman move to re-fetch elevations
    const EARTH_R = 6371000;
    const D2R = Math.PI / 180;
    const R2D = 180 / Math.PI;

    // State
    let svCanvas = null;
    let svCtx = null;
    let panorama = null;
    let elevService = null;
    let listeners = [];
    let animId = null;
    let dirty = false;

    // Elevation cache: key = "lat5,lng5" → elevation in metres
    let elevCache = {};
    let lastFetchLL = null;
    let camElevation = 0;
    let elevApiDenied = false;

    // Mapbox interaction state
    let isStreetViewActive = false;
    let pegmanMarker = null;

    // Coordinate helpers
    function haversine(a, b) {
        let dLat = (b[0] - a[0]) * D2R, dLng = (b[1] - a[1]) * D2R;
        let s = Math.sin(dLat / 2), t = Math.sin(dLng / 2);
        return 2 * EARTH_R * Math.asin(Math.sqrt(
            s * s + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * t * t));
    }

    function bearing(a, b) {
        let la = a[0] * D2R, lb = b[0] * D2R, dl = (b[1] - a[1]) * D2R;
        return (Math.atan2(
            Math.sin(dl) * Math.cos(lb),
            Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dl)
        ) * R2D + 360) % 360;
    }

    function elevKey(lat, lng) {
        return lat.toFixed(5) + ',' + lng.toFixed(5);
    }

    // Densification
    function densifyToLL(coords) {
        let result = [];
        for (let i = 0; i < coords.length; i++) {
            let llA = [coords[i][1], coords[i][0]]; // [lat, lng]
            result.push(llA);
            if (i < coords.length - 1) {
                let llB = [coords[i + 1][1], coords[i + 1][0]];
                let d = haversine(llA, llB);
                let steps = Math.ceil(d / DENSIFY_STEP_M);
                if (steps > 1) {
                    let dLat = (llB[0] - llA[0]) / steps;
                    let dLng = (llB[1] - llA[1]) / steps;
                    for (let k = 1; k < steps; k++) {
                        result.push([llA[0] + dLat * k, llA[1] + dLng * k]);
                    }
                }
            }
        }
        return result;
    }

    // Extract network features directly from the SWMM network model
    function extractMapboxFeatures() {
        const features = [];

        // Helper: get SWMM element colors
        const nodeColors = (window.SWMM_COLORS && window.SWMM_COLORS.NODE_COLORS) || {
            JUNCTION: '#1565c0', OUTFALL: '#2e7d32', STORAGE: '#6a1b9a',
            DIVIDER: '#ef6c00', RAINGAGE: '#00838f'
        };
        const linkColors = (window.SWMM_COLORS && window.SWMM_COLORS.LINK_COLORS) || {
            CONDUIT: '#455a64', PUMP: '#c62828', WEIR: '#ad1457', ORIFICE: '#4527a0'
        };

        // Nodes
        if (window.Net && typeof Net.nodesGeoJSON === 'function') {
            const nodesGeoJSON = Net.nodesGeoJSON();
            if (nodesGeoJSON && nodesGeoJSON.features) {
                nodesGeoJSON.features.forEach(f => {
                    const color = nodeColors[f.properties && f.properties.type] || '#1565c0';
                    f._svColor = color;
                    features.push(f);
                });
            }
        }

        // Links
        if (window.Net && typeof Net.linksGeoJSON === 'function') {
            const linksGeoJSON = Net.linksGeoJSON();
            if (linksGeoJSON && linksGeoJSON.features) {
                linksGeoJSON.features.forEach(f => {
                    const color = linkColors[f.properties && f.properties.type] || '#455a64';
                    f._svColor = color;
                    features.push(f);
                });
            }
        }

        return features;
    }

    // Elevation fetching
    function collectUncachedVertices(camLL) {
        let pending = [];
        const features = extractMapboxFeatures();
        
        features.forEach(feature => {
            const geom = feature.geometry;
            if (!geom) return;
            
            let coords = [];
            if (geom.type === 'LineString') coords = [geom.coordinates];
            else if (geom.type === 'MultiLineString') coords = geom.coordinates;
            else if (geom.type === 'Polygon') coords = geom.coordinates;
            else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(p => coords = coords.concat(p));
            else if (geom.type === 'Point') coords = [[geom.coordinates]];
            else if (geom.type === 'MultiPoint') coords = geom.coordinates.map(pt => [pt]);

            coords.forEach(ring => {
                let dense = densifyToLL(ring);
                dense.forEach(ll => {
                    if (haversine(camLL, ll) > MAX_DIST_M) return;
                    let k = elevKey(ll[0], ll[1]);
                    if (!elevCache[k]) pending.push({ k: k, lat: ll[0], lng: ll[1] });
                });
            });
        });
        
        // Deduplicate
        let seen = {}, unique = [];
        pending.forEach(p => {
            if (!seen[p.k]) { seen[p.k] = true; unique.push(p); }
        });
        return unique;
    }

    function fetchElevations(entries, onDone) {
        if (!entries.length || elevApiDenied) { onDone(); return; }
        let BATCH = 500;
        let batches = [];
        for (let i = 0; i < entries.length; i += BATCH)
            batches.push(entries.slice(i, i + BATCH));

        let remaining = batches.length;
        function done() { if (--remaining === 0) onDone(); }

        batches.forEach(batch => {
            let locs = batch.map(e => new google.maps.LatLng(e.lat, e.lng));
            elevService.getElevationForLocations({ locations: locs }, function (results, status) {
                if (status === 'OK' && results) {
                    results.forEach((r, i) => { elevCache[batch[i].k] = r.elevation; });
                } else {
                    if (status === 'REQUEST_DENIED') elevApiDenied = true;
                    batch.forEach(e => { if (!elevCache[e.k]) elevCache[e.k] = null; });
                }
                done();
            });
        });
    }

    function updateElevations(camLL) {
        if (!elevService || elevApiDenied) {
            scheduleRedraw();
            return;
        }

        let camLatLng = new google.maps.LatLng(camLL[0], camLL[1]);
        let camKey = elevKey(camLL[0], camLL[1]);

        function step2(camElev) {
            camElevation = camElev;
            elevCache[camKey] = camElev;
            let pending = collectUncachedVertices(camLL);
            fetchElevations(pending, () => scheduleRedraw());
        }

        if (elevCache[camKey] !== undefined && elevCache[camKey] !== null) {
            step2(elevCache[camKey]);
        } else {
            elevService.getElevationForLocations({ locations: [camLatLng] }, (results, status) => {
                if (status === 'REQUEST_DENIED') {
                    elevApiDenied = true;
                    scheduleRedraw();
                    return;
                }
                let elev = (status === 'OK' && results && results[0]) ? results[0].elevation : 0;
                step2(elev);
            });
        }
    }

    // Projection
    function getFocal(zoom, W) {
        let hFov = 180 / Math.pow(2, zoom);
        hFov = Math.min(170, Math.max(1, hFov));
        return (W / 2) / Math.tan(hFov / 2 * D2R);
    }

    function project(camLL, ptLL, heading, pitch, f, W, H) {
        let d = haversine(camLL, ptLL);
        if (d < 0.1 || d > MAX_DIST_M) return null;

        let bear = bearing(camLL, ptLL);

        let dElev = 0;
        
        // 1. Try Mapbox Terrain Elevation (Free, local, matches 3D mesh)
        let mbVertElev = null;
        let mbCamElev = null;
        if (window.map && window.map.queryTerrainElevation) {
            mbVertElev = window.map.queryTerrainElevation([ptLL[1], ptLL[0]]);
            mbCamElev = window.map.queryTerrainElevation([camLL[1], camLL[0]]);
        }
        
        if (mbVertElev !== null && mbCamElev !== null) {
            dElev = mbVertElev - mbCamElev;
        } else {
            // 2. Fallback to Google Elevation API cache
            let vertKey = elevKey(ptLL[0], ptLL[1]);
            let vertElev = elevCache[vertKey];
            
            if (vertElev !== undefined && vertElev !== null && camElevation !== undefined) {
                dElev = vertElev - camElevation;
            }
        }
        
        let effectiveH = CAM_HEIGHT - dElev;
        let pitchPt = -Math.atan2(effectiveH, d) * R2D;

        let lam = bear * D2R;
        let phi = pitchPt * D2R;
        let lam0 = heading * D2R;
        let phi0 = pitch * D2R;

        let cosC = Math.sin(phi0) * Math.sin(phi)
            + Math.cos(phi0) * Math.cos(phi) * Math.cos(lam - lam0);

        if (cosC <= 0.01) return null;

        let xNorm = Math.cos(phi) * Math.sin(lam - lam0) / cosC;
        let yNorm = (Math.cos(phi0) * Math.sin(phi)
            - Math.sin(phi0) * Math.cos(phi) * Math.cos(lam - lam0)) / cosC;

        return { x: W / 2 + f * xNorm, y: H / 2 - f * yNorm };
    }

    // Style Extraction
    function extractMapboxStyle(feature) {
        let color = feature._svColor || 'rgba(255,255,255,0.8)';
        
        // Use animation result color if active
        if (window.ResultStyling && window.ResultStyling.active && window.ResultStyling.timeSeries) {
            const step = window.ResultStyling.currentStep || 0;
            const ts = window.ResultStyling.timeSeries;
            const id = feature.properties.id;
            const type = feature.properties.type;
            const isNode = ['JUNCTION', 'OUTFALL', 'STORAGE', 'DIVIDER'].includes(type);
            const isLink = ['CONDUIT', 'PUMP', 'WEIR', 'ORIFICE'].includes(type);
            
            if (isNode && ts.nodes[id] && ts.nodes[id].depth) {
                const val = ts.nodes[id].depth[step];
                if (val !== undefined) {
                    const nMin = window.ResultStyling.nodeMinMax.min, nMax = window.ResultStyling.nodeMinMax.max;
                    const t = nMax > nMin ? (val - nMin) / (nMax - nMin) : 0.5;
                    if (window.rampColor) color = window.rampColor(t);
                }
            } else if (isLink && ts.links[id] && ts.links[id].flow) {
                const val = ts.links[id].flow[step];
                if (val !== undefined) {
                    const lMin = window.ResultStyling.linkMinMax.min, lMax = window.ResultStyling.linkMinMax.max;
                    const t = lMax > lMin ? (Math.abs(val) - lMin) / (lMax - lMin) : 0.5;
                    if (window.rampColor) color = window.rampColor(t);
                }
            }
        }
        
        let width = 2;
        
        const geomType = feature.geometry ? feature.geometry.type : '';
        
        if (geomType.includes('LineString') || geomType.includes('Polygon')) {
            width = 6;
        }

        return { color, width };
    }

    // Drawing
    function drawLL(llPoints, camLL, heading, pitch, f, W, H, close) {
        let hasPoint = false;
        svCtx.beginPath();
        let started = false;
        for (let i = 0; i < llPoints.length; i++) {
            let p = project(camLL, llPoints[i], heading, pitch, f, W, H);
            if (!p) { started = false; continue; }
            hasPoint = true;
            if (!started) { svCtx.moveTo(p.x, p.y); started = true; }
            else { svCtx.lineTo(p.x, p.y); }
        }
        if (close && started) svCtx.closePath();
        return hasPoint;
    }

    function render() {
        if (!svCanvas || !panorama || !panorama.getVisible()) return;

        let W = svCanvas.width, H = svCanvas.height;
        if (!W || !H) return;

        svCtx.clearRect(0, 0, W, H);

        let pos = panorama.getPosition();
        if (!pos) return;
        let camLL = [pos.lat(), pos.lng()];

        let pov = panorama.getPov();
        let heading = pov.heading || 0;
        let pitch = pov.pitch || 0;
        let zoom = (pov.zoom !== undefined) ? pov.zoom : 1;
        let f = getFocal(zoom, W);

        const features = extractMapboxFeatures();

        features.forEach(feature => {
            const geom = feature.geometry;
            if (!geom) return;

            const sk = extractMapboxStyle(feature);
            svCtx.strokeStyle = sk.color;
            svCtx.lineWidth = sk.width;
            svCtx.lineJoin = 'round';
            svCtx.lineCap = 'round';
            
            const isPolygon = geom.type.includes('Polygon');
            if (isPolygon) {
                svCtx.fillStyle = 'rgba(99, 102, 241, 0.2)'; // fill polygons slightly
            }

            let type = geom.type;
            if (type === 'LineString') {
                let ll = densifyToLL(geom.coordinates);
                if (drawLL(ll, camLL, heading, pitch, f, W, H, false)) svCtx.stroke();
            } else if (type === 'MultiLineString') {
                geom.coordinates.forEach(ls => {
                    let ll = densifyToLL(ls);
                    if (drawLL(ll, camLL, heading, pitch, f, W, H, false)) svCtx.stroke();
                });
            } else if (type === 'Polygon') {
                geom.coordinates.forEach(ring => {
                    let ll = densifyToLL(ring);
                    if (drawLL(ll, camLL, heading, pitch, f, W, H, true)) {
                        svCtx.fill();
                        svCtx.stroke();
                    }
                });
            } else if (type === 'MultiPolygon') {
                geom.coordinates.forEach(poly => {
                    poly.forEach(ring => {
                        let ll = densifyToLL(ring);
                        if (drawLL(ll, camLL, heading, pitch, f, W, H, true)) {
                            svCtx.fill();
                            svCtx.stroke();
                        }
                    });
                });
            } else if (type === 'Point') {
                let ptLL = [geom.coordinates[1], geom.coordinates[0]];
                let p = project(camLL, ptLL, heading, pitch, f, W, H);
                if (p) {
                    svCtx.beginPath(); svCtx.arc(p.x, p.y, 8, 0, 2 * Math.PI);
                    svCtx.fillStyle = sk.color; svCtx.fill();
                    svCtx.strokeStyle = 'white'; svCtx.lineWidth = 2; svCtx.stroke();
                }
            } else if (type === 'MultiPoint') {
                geom.coordinates.forEach(pt => {
                    let ptLL = [pt[1], pt[0]];
                    let p = project(camLL, ptLL, heading, pitch, f, W, H);
                    if (p) {
                        svCtx.beginPath(); svCtx.arc(p.x, p.y, 8, 0, 2 * Math.PI);
                        svCtx.fillStyle = sk.color; svCtx.fill();
                        svCtx.strokeStyle = 'white'; svCtx.lineWidth = 2; svCtx.stroke();
                    }
                });
            }
        });
        
        // Sync Mapbox Camera to Street View Camera (approximate heading/pitch)
        if (window.map) {
            map.setBearing(heading);
            // Mapbox pitch is 0-85, SV pitch is -90 to 90
            let mappedPitch = pitch + 90; // 0 (looking straight down) to 180 (looking up)
            if (mappedPitch > 85) mappedPitch = 85;
            map.setPitch(mappedPitch / 2); // Approximated
            
            if (pegmanMarker) {
                pegmanMarker.setRotation(heading);
            }
        }
    }

    function scheduleRedraw() {
        dirty = true;
        if (!animId) {
            animId = requestAnimationFrame(() => {
                animId = null;
                if (dirty) { dirty = false; render(); }
            });
        }
    }

    function onPositionChanged() {
        let pos = panorama.getPosition();
        if (!pos) return;
        let camLL = [pos.lat(), pos.lng()];

        if (window.map) {
            // Update mapbox center too
            map.setCenter([pos.lng(), pos.lat()]);
            if (pegmanMarker) {
                pegmanMarker.setLngLat([pos.lng(), pos.lat()]);
            }
        }

        let needsFetch = !lastFetchLL || haversine(lastFetchLL, camLL) > MOVE_THRESH_M;
        if (needsFetch) {
            lastFetchLL = camLL;
            updateElevations(camLL);
        } else {
            scheduleRedraw();
        }
    }

    // Canvas lifecycle
    function createCanvas() {
        let panoDiv = document.getElementById('street-view-container');
        let wrapperDiv = document.getElementById('street-view-wrapper');
        if (!panoDiv || !wrapperDiv) return false;

        svCanvas = document.createElement('canvas');
        svCanvas.id = 'sv-overlay-canvas';
        Object.assign(svCanvas.style, {
            position: 'absolute', top: '0', left: '0',
            width: '100%', height: '100%',
            pointerEvents: 'none', zIndex: '1000'
        });
        wrapperDiv.appendChild(svCanvas);
        svCtx = svCanvas.getContext('2d');

        function syncSize() {
            if (!svCanvas) return;
            svCanvas.width = svCanvas.offsetWidth;
            svCanvas.height = svCanvas.offsetHeight;
            scheduleRedraw();
        }
        
        const ro = new ResizeObserver(syncSize);
        ro.observe(panoDiv);
        svCanvas._ro = ro;
        
        setTimeout(syncSize, 150);
        return true;
    }

    function initStreetView() {
        try {
            const container = document.getElementById('street-view-container');
            
            let initialPos = { lat: -29.908, lng: -71.254 };
            if (window.map) {
                const center = map.getCenter();
                initialPos = { lat: center.lat, lng: center.lng };
            }

            const svService = new google.maps.StreetViewService();
            svService.getPanorama({ location: initialPos, radius: 100 }, (data, status) => {
                if (status === 'OK') {
                    panorama = new google.maps.StreetViewPanorama(container, {
                        position: data.location.latLng,
                        pov: { heading: window.map ? map.getBearing() : 0, pitch: 0, zoom: 1 },
                        zoomControl: false,
                        addressControl: false,
                        fullscreenControl: false,
                        linksControl: true,
                        panControl: false,
                        enableCloseButton: false
                    });

                    try { elevService = new google.maps.ElevationService(); }
                    catch (e) { console.warn('ElevationService unavailable'); }

                    createCanvas();

                    if (window.map) {
                        const el = document.createElement('div');
                        el.innerHTML = `<svg viewBox="-30 -30 60 60" width="80" height="80" style="cursor: grab; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5)); transform: translateY(-10px)">
                          <path d="M0 0 L-20 -40 A 45 45 0 0 1 20 -40 Z" fill="rgba(255,255,255,0.4)" stroke="rgba(255,255,255,0.8)" stroke-width="1"/>
                          <circle cx="0" cy="0" r="10" fill="#eab308" stroke="#000" stroke-width="2"/>
                          <circle cx="0" cy="0" r="4" fill="#000"/>
                        </svg>`;
                        pegmanMarker = new mapboxgl.Marker({ 
                            element: el, 
                            draggable: true,
                            rotationAlignment: 'map',
                            pitchAlignment: 'map'
                        })
                        .setLngLat([initialPos.lng, initialPos.lat])
                        .addTo(window.map);

                        pegmanMarker.on('dragend', () => {
                            const lngLat = pegmanMarker.getLngLat();
                            panorama.setPosition({ lat: lngLat.lat, lng: lngLat.lng });
                        });
                    }

                    listeners.push(panorama.addListener('pov_changed', scheduleRedraw));
                    listeners.push(panorama.addListener('position_changed', onPositionChanged));
                    
                    if (window.map) {
                        map.on('moveend', scheduleRedraw);
                        map.on('render', scheduleRedraw); 
                    }

                    onPositionChanged();
                } else {
                    alert("No hay cobertura de Street View en este punto (status: " + status + "). Intenta en otra calle.");
                    const closeBtn = document.getElementById('btn-close-sv');
                    if (closeBtn) closeBtn.click();
                }
            });
        } catch (error) {
            alert("Error al inicializar Street View: " + error.message);
            const closeBtn = document.getElementById('btn-close-sv');
            if (closeBtn) closeBtn.click();
        }
    }
    
    function destroyStreetView() {
        listeners.forEach(l => google.maps.event.removeListener(l));
        listeners = [];
        
        if (window.map) {
            map.off('moveend', scheduleRedraw);
            map.off('render', scheduleRedraw);
        }

        if (pegmanMarker) {
            pegmanMarker.remove();
            pegmanMarker = null;
        }

        if (svCanvas) {
            if (svCanvas._ro) svCanvas._ro.disconnect();
            if (svCanvas.parentNode) svCanvas.parentNode.removeChild(svCanvas);
            svCanvas = null;
        }
        panorama = null;
        if (animId) { 
            cancelAnimationFrame(animId); 
            animId = null; 
        }

        // Clean up any remaining Google Maps DOM elements to prevent overlapping next time
        const container = document.getElementById('street-view-container');
        if (container) {
            container.innerHTML = '';
        }
    }

    // Export API
    window.StreetViewOverlay = {
        init: initStreetView,
        destroy: destroyStreetView,
        scheduleRedraw: scheduleRedraw,
        updatePosition: function(lngLat) {
            if (panorama) {
                panorama.setPosition({ lat: lngLat.lat, lng: lngLat.lng });
            }
        }
    };

})();
