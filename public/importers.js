// importers.js — Shapefile (shpjs), DXF (dxf-parser), and
// master plan reference overlay imports.

(function () {
    'use strict';

    // pending import awaiting "import as" choice: { geojson, name }
    let pendingImport = null;

    const importasModal = document.getElementById('importas-modal');
    const importasInfo = document.getElementById('importas-info');

    function openImportAsModal(geojson, name) {
        pendingImport = { geojson, name };
        const counts = countGeoms(geojson);
        importasInfo.textContent =
            `"${name}" — ${counts.points} point(s), ${counts.lines} line(s), ${counts.polygons} polygon(s). Import as:`;
        importasModal.classList.remove('hidden');
    }

    document.getElementById('btn-cancel-importas').addEventListener('click', () => {
        importasModal.classList.add('hidden');
        pendingImport = null;
    });

    document.getElementById('btn-confirm-importas').addEventListener('click', () => {
        importasModal.classList.add('hidden');
        if (!pendingImport) return;
        const mode = document.querySelector('input[name="importas-type"]:checked').value;
        if (mode === 'masterplan') {
            window.setMasterPlan(pendingImport.geojson);
            fitToGeoJSON(pendingImport.geojson);
        } else {
            importGeoJSONAsNetwork(pendingImport.geojson);
        }
        pendingImport = null;
    });

    function countGeoms(geojson) {
        const c = { points: 0, lines: 0, polygons: 0 };
        (geojson.features || []).forEach(f => {
            const t = f.geometry && f.geometry.type;
            if (t === 'Point' || t === 'MultiPoint') c.points++;
            else if (t === 'LineString' || t === 'MultiLineString') c.lines++;
            else if (t === 'Polygon' || t === 'MultiPolygon') c.polygons++;
        });
        return c;
    }

    function fitToGeoJSON(geojson) {
        const coords = [];
        const walk = (c) => {
            if (typeof c[0] === 'number') coords.push(c);
            else c.forEach(walk);
        };
        (geojson.features || []).forEach(f => f.geometry && walk(f.geometry.coordinates));
        if (!coords.length) return;
        const bounds = coords.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(coords[0], coords[0]));
        map.fitBounds(bounds, { padding: 80, duration: 1200, maxZoom: 17 });
    }

    // ---------- looks-like-lon/lat heuristic ----------
    function looksLikeLngLat(geojson) {
        let sample = null;
        const walk = (c) => {
            if (sample) return;
            if (typeof c[0] === 'number') { sample = c; return; }
            c.forEach(walk);
        };
        (geojson.features || []).some(f => { f.geometry && walk(f.geometry.coordinates); return !!sample; });
        if (!sample) return true;
        return Math.abs(sample[0]) <= 180 && Math.abs(sample[1]) <= 90;
    }

    // GeoJSON → network model
    function importGeoJSONAsNetwork(geojson) {
        const model = { title: Net.title, units: Net.units, options: {}, nodes: [], links: [], subcatchments: [] };
        const autoNodes = [];   // nodes auto-created at line endpoints
        let ni = 0, li = 0, si = 0;

        const nodeKey = (c) => c[0].toFixed(7) + ',' + c[1].toFixed(7);
        const nodeAt = {};      // key -> id

        function ensureNode(c) {
            const key = nodeKey(c);
            if (nodeAt[key]) return nodeAt[key];
            const id = 'IMP_J' + (++ni);
            nodeAt[key] = id;
            autoNodes.push({
                id, type: 'JUNCTION', lngLat: [c[0], c[1]],
                props: { invertEl: 0, maxDepth: 2, initDepth: 0, surDepth: 0, aponded: 0 }
            });
            return id;
        }

        (geojson.features || []).forEach(f => {
            const g = f.geometry;
            if (!g) return;
            const props = f.properties || {};
            const name = props.name || props.Name || props.ID || props.id || null;

            const addLine = (coords) => {
                if (coords.length < 2) return;
                const from = ensureNode(coords[0]);
                const to = ensureNode(coords[coords.length - 1]);
                model.links.push({
                    id: name && !model.links.some(l => l.id === name) ? String(name).replace(/\s+/g, '_') : 'IMP_C' + (++li),
                    type: 'CONDUIT', from, to,
                    vertices: coords.slice(1, -1).map(c => [c[0], c[1]]),
                    props: {
                        length: 0, autoLength: true,
                        roughness: parseFloat(props.roughness) || 0.013,
                        inOffset: 0, outOffset: 0, initFlow: 0, maxFlow: 0,
                        xShape: 'CIRCULAR', geom1: parseFloat(props.diameter) || 1.0,
                        geom2: 0, geom3: 0, geom4: 0, barrels: 1
                    }
                });
            };

            const addPolygon = (ring) => {
                if (ring.length < 3) return;
                // drop closing dup
                const open = [...ring];
                if (open.length > 3 && nodeKey(open[0]) === nodeKey(open[open.length - 1])) open.pop();
                model.subcatchments.push({
                    id: name && !model.subcatchments.some(s => s.id === name) ? String(name).replace(/\s+/g, '_') : 'IMP_S' + (++si),
                    ring: open.map(c => [c[0], c[1]]),
                    props: {
                        raingage: 'RG1', outlet: '',
                        area: parseFloat(props.area) || 0, autoArea: true,
                        imperv: parseFloat(props.imperv) || 50,
                        width: parseFloat(props.width) || 500,
                        slope: parseFloat(props.slope) || 0.5, curbLen: 0
                    }
                });
            };

            if (g.type === 'Point') {
                model.nodes.push({
                    id: name && !model.nodes.some(n => n.id === name) ? String(name).replace(/\s+/g, '_') : 'IMP_J' + (++ni),
                    type: 'JUNCTION', lngLat: [g.coordinates[0], g.coordinates[1]],
                    props: {
                        invertEl: parseFloat(props.elevation) || 0,
                        maxDepth: parseFloat(props.maxDepth) || 2,
                        initDepth: 0, surDepth: 0, aponded: 0
                    }
                });
            } else if (g.type === 'MultiPoint') {
                g.coordinates.forEach(c => model.nodes.push({
                    id: 'IMP_J' + (++ni), type: 'JUNCTION', lngLat: [c[0], c[1]],
                    props: { invertEl: 0, maxDepth: 2, initDepth: 0, surDepth: 0, aponded: 0 }
                }));
            } else if (g.type === 'LineString') {
                addLine(g.coordinates);
            } else if (g.type === 'MultiLineString') {
                g.coordinates.forEach(addLine);
            } else if (g.type === 'Polygon') {
                addPolygon(g.coordinates[0]);
            } else if (g.type === 'MultiPolygon') {
                g.coordinates.forEach(p => addPolygon(p[0]));
            }
        });

        // register explicit point nodes in the endpoint lookup so lines snap to them
        model.nodes.forEach(n => { nodeAt[nodeKey(n.lngLat)] = n.id; });
        // remove auto-nodes duplicated by explicit ones, remap link refs
        const explicitByKey = {};
        model.nodes.forEach(n => explicitByKey[nodeKey(n.lngLat)] = n.id);
        const keep = [];
        autoNodes.forEach(an => {
            const key = nodeKey(an.lngLat);
            if (explicitByKey[key] && explicitByKey[key] !== an.id) {
                model.links.forEach(l => {
                    if (l.from === an.id) l.from = explicitByKey[key];
                    if (l.to === an.id) l.to = explicitByKey[key];
                });
            } else {
                keep.push(an);
            }
        });
        model.nodes = model.nodes.concat(keep);

        window.loadModelIntoNetwork(model, true); // merge into current network
    }

    // Shapefile
    const shpInput = document.getElementById('shp-file-input');
    document.getElementById('btn-import-shp').addEventListener('click', () => shpInput.click());

    shpInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        shpInput.value = '';
        if (!file) return;
        if (typeof shp === 'undefined') {
            alert('Shapefile library (shpjs) failed to load. Check your internet connection.');
            return;
        }
        try {
            const buf = await file.arrayBuffer();
            let geojson = await shp(buf); // handles .zip; bare .shp gives geometry-only
            if (Array.isArray(geojson)) {
                // multiple layers in zip → merge
                geojson = {
                    type: 'FeatureCollection',
                    features: geojson.flatMap(g => g.features || [])
                };
            }
            if (!geojson || !geojson.features || !geojson.features.length) {
                alert('No features found in the shapefile.');
                return;
            }
            if (!looksLikeLngLat(geojson)) {
                // projected shapefile without/with unknown .prj — route through projection modal
                window.openProjectionModalForGeoJSON(geojson, file.name);
                return;
            }
            openImportAsModal(geojson, file.name);
        } catch (err) {
            console.error(err);
            alert('Failed to read shapefile: ' + err.message + '\nTip: upload a .zip containing .shp, .dbf and .prj.');
        }
    });

    // DXF
    const dxfInput = document.getElementById('dxf-file-input');
    document.getElementById('btn-import-dxf').addEventListener('click', () => dxfInput.click());

    dxfInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        dxfInput.value = '';
        if (!file) return;
        if (typeof DxfParser === 'undefined') {
            alert('DXF library (dxf-parser) failed to load. Check your internet connection.');
            return;
        }
        try {
            const text = await file.text();
            const parser = new DxfParser();
            const dxf = parser.parseSync(text);
            const geojson = dxfToGeoJSON(dxf);
            if (!geojson.features.length) {
                alert('No supported entities (LINE, LWPOLYLINE, POLYLINE, POINT, INSERT, CIRCLE) found in the DXF.');
                return;
            }
            // DXF is virtually always in projected/local CAD coordinates
            window.openProjectionModalForGeoJSON(geojson, file.name);
        } catch (err) {
            console.error(err);
            alert('Failed to parse DXF: ' + err.message);
        }
    });

    function dxfToGeoJSON(dxf) {
        const features = [];
        (dxf.entities || []).forEach(ent => {
            try {
                if (ent.type === 'LINE' && ent.vertices && ent.vertices.length >= 2) {
                    features.push(lineFeat(ent.vertices.map(v => [v.x, v.y]), ent));
                } else if ((ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') && ent.vertices && ent.vertices.length >= 2) {
                    const coords = ent.vertices.map(v => [v.x, v.y]);
                    if (ent.shape || ent.closed) {
                        coords.push(coords[0]);
                        features.push({ type: 'Feature', properties: { layer: ent.layer }, geometry: { type: 'Polygon', coordinates: [coords] } });
                    } else {
                        features.push(lineFeat(coords, ent));
                    }
                } else if (ent.type === 'POINT' && ent.position) {
                    features.push(pointFeat([ent.position.x, ent.position.y], ent));
                } else if (ent.type === 'INSERT' && ent.position) {
                    features.push(pointFeat([ent.position.x, ent.position.y], ent));
                } else if (ent.type === 'CIRCLE' && ent.center) {
                    features.push(pointFeat([ent.center.x, ent.center.y], ent));
                }
            } catch (e) { /* skip malformed entity */ }
        });
        return { type: 'FeatureCollection', features };

        function lineFeat(coords, ent) {
            return { type: 'Feature', properties: { layer: ent.layer }, geometry: { type: 'LineString', coordinates: coords } };
        }
        function pointFeat(c, ent) {
            return { type: 'Feature', properties: { layer: ent.layer, name: ent.name }, geometry: { type: 'Point', coordinates: c } };
        }
    }

    // Projection modal for GeoJSON (shapefile/DXF path)
    // Reuses the same modal as INP import; app.js exposes openProjectionModal
    // for models — here we wrap a GeoJSON in a fake "model" transform flow.
    window.openProjectionModalForGeoJSON = function (geojson, name) {
        // Build a lightweight adapter object that transformModelCoords in app.js
        // can't consume directly, so we do the projection here after modal confirm.
        const modal = document.getElementById('projection-modal');
        modal.classList.remove('hidden');

        const btnConfirm = document.getElementById('btn-confirm-proj');
        const btnCancel = document.getElementById('btn-cancel-proj');

        const cleanup = () => {
            btnConfirm.removeEventListener('click', onConfirm, true);
            btnCancel.removeEventListener('click', onCancel);
        };

        const onCancel = () => { modal.classList.add('hidden'); cleanup(); };

        const onConfirm = async (e) => {
            e.stopImmediatePropagation(); // don't trigger the INP handler
            modal.classList.add('hidden');
            cleanup();
            const coordType = document.querySelector('input[name="coord-type"]:checked').value;
            const epsgCode = document.getElementById('epsg-code-input').value.trim() || 'EPSG:32719';

            if (coordType === 'utm' && window.proj4) {
                try {
                    const code = epsgCode.split(':')[1];
                    const res = await fetch(`https://epsg.io/${code}.proj4`);
                    if (res.ok) proj4.defs(epsgCode, await res.text());
                    transformGeoJSON(geojson, c => proj4(epsgCode, 'EPSG:4326', [c[0], c[1]]));
                } catch (err) {
                    alert('Reprojection failed: ' + err.message);
                    return;
                }
            } else if (coordType === 'local') {
                normalizeGeoJSONLocal(geojson);
            }
            openImportAsModal(geojson, name);
        };

        // capture-phase so stopImmediatePropagation shields the INP listener
        btnConfirm.addEventListener('click', onConfirm, true);
        btnCancel.addEventListener('click', onCancel);
    };

    function transformGeoJSON(geojson, fn) {
        const walk = (c) => {
            if (typeof c[0] === 'number') return fn(c);
            return c.map(walk);
        };
        geojson.features.forEach(f => {
            if (f.geometry) f.geometry.coordinates = walk(f.geometry.coordinates);
        });
    }

    function normalizeGeoJSONLocal(geojson) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const scan = (c) => {
            if (typeof c[0] === 'number') {
                if (c[0] < minX) minX = c[0];
                if (c[0] > maxX) maxX = c[0];
                if (c[1] < minY) minY = c[1];
                if (c[1] > maxY) maxY = c[1];
            } else c.forEach(scan);
        };
        geojson.features.forEach(f => f.geometry && scan(f.geometry.coordinates));
        if (!isFinite(minX)) return;
        const center = map.getCenter();
        const scale = 0.02 / Math.max(maxX - minX || 1, maxY - minY || 1);
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        transformGeoJSON(geojson, c => [center.lng + (c[0] - cx) * scale, center.lat + (c[1] - cy) * scale]);
    }

    // expose for ui.js drag&drop reuse
    window.Importers = { openImportAsModal, importGeoJSONAsNetwork, looksLikeLngLat, fitToGeoJSON };
})();
