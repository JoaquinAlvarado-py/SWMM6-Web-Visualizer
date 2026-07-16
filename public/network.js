// network.js — Project state, undo/redo, persistence
// Single source of truth for the SWMM network being edited.

(function () {
    'use strict';

    const NODE_TYPES = ['JUNCTION', 'OUTFALL', 'STORAGE', 'DIVIDER', 'RAINGAGE'];
    const LINK_TYPES = ['CONDUIT', 'PUMP', 'WEIR', 'ORIFICE'];

    const ID_PREFIX = {
        JUNCTION: 'J', OUTFALL: 'O', STORAGE: 'ST', DIVIDER: 'D', RAINGAGE: 'RG',
        CONDUIT: 'C', PUMP: 'P', WEIR: 'W', ORIFICE: 'OR', SUBCATCHMENT: 'S'
    };

    function defaultNodeProps(type) {
        switch (type) {
            case 'JUNCTION': return { invertEl: 0, maxDepth: 2, initDepth: 0, surDepth: 0, aponded: 0 };
            case 'OUTFALL': return { invertEl: 0, outfallType: 'FREE', stageData: '', gated: 'NO' };
            case 'STORAGE': return { invertEl: 0, maxDepth: 5, initDepth: 0, shape: 'FUNCTIONAL', coeff: 1000, exponent: 0, constant: 0 };
            case 'DIVIDER': return { invertEl: 0, divertedLink: '', dividerType: 'CUTOFF', param: 0, maxDepth: 2 };
            case 'RAINGAGE': return { format: 'INTENSITY', interval: '1:00', scf: 1.0, sourceType: 'TIMESERIES', sourceName: 'TS1' };
            default: return {};
        }
    }

    function defaultLinkProps(type) {
        switch (type) {
            case 'CONDUIT': return { length: 0, autoLength: true, roughness: 0.013, inOffset: 0, outOffset: 0, initFlow: 0, maxFlow: 0, xShape: 'CIRCULAR', geom1: 1.0, geom2: 0, geom3: 0, geom4: 0, barrels: 1 };
            case 'PUMP': return { pumpCurve: '*', status: 'ON', startup: 0, shutoff: 0 };
            case 'WEIR': return { weirType: 'TRANSVERSE', crestHt: 0, qCoeff: 3.33, gated: 'NO', xShape: 'RECT_OPEN', geom1: 1.0, geom2: 1.0, geom3: 0, geom4: 0 };
            case 'ORIFICE': return { orificeType: 'SIDE', offset: 0, qCoeff: 0.65, gated: 'NO', xShape: 'CIRCULAR', geom1: 1.0, geom2: 0, geom3: 0, geom4: 0 };
            default: return {};
        }
    }

    function defaultSubcatchProps() {
        return { raingage: 'RG1', outlet: '', area: 0, autoArea: true, imperv: 50, width: 500, slope: 0.5, curbLen: 0 };
    }

    function defaultOptions() {
        return {
            infiltration: 'HORTON',
            flowRouting: 'KINWAVE',
            startDate: '01/01/2026', startTime: '00:00:00',
            endDate: '01/01/2026', endTime: '12:00:00',
            reportStep: '00:15:00', wetStep: '00:05:00',
            dryStep: '01:00:00', routingStep: '00:00:30'
        };
    }

    // --- Geometry helpers (WGS84) ---
    const R_EARTH = 6371008.8;
    function haversine(a, b) {
        const dLat = (b[1] - a[1]) * Math.PI / 180;
        const dLng = (b[0] - a[0]) * Math.PI / 180;
        const la1 = a[1] * Math.PI / 180, la2 = b[1] * Math.PI / 180;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
        return 2 * R_EARTH * Math.asin(Math.sqrt(h));
    }

    function pathLengthMeters(coords) {
        let d = 0;
        for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
        return d;
    }

    // Approximate geodesic ring area in m² (shoelace on projected coords)
    function ringAreaM2(ring) {
        if (ring.length < 3) return 0;
        const lat0 = ring[0][1] * Math.PI / 180;
        const mPerDegX = 111320 * Math.cos(lat0);
        const mPerDegY = 110540;
        let area = 0;
        for (let i = 0; i < ring.length; i++) {
            const j = (i + 1) % ring.length;
            const xi = ring[i][0] * mPerDegX, yi = ring[i][1] * mPerDegY;
            const xj = ring[j][0] * mPerDegX, yj = ring[j][1] * mPerDegY;
            area += xi * yj - xj * yi;
        }
        return Math.abs(area / 2);
    }

    class Network {
        constructor() {
            this.reset(false);
            this.history = [];
            this.hIndex = -1;
            this.listeners = [];
            this._saveTimer = null;
            this.commit(); // initial empty snapshot
        }

        reset(notify = true) {
            this.nodes = [];
            this.links = [];
            this.subcatchments = [];
            this.mesh2D = []; // Added for 2D mesh
            this.options = defaultOptions();
            this.units = 'SI';
            this.title = 'Untitled SWMM Project';
            this.counters = {};
            if (notify) this.emit();
        }

        // ---------- events ----------
        onChange(fn) { this.listeners.push(fn); }
        emit() {
            this.listeners.forEach(fn => { try { fn(this); } catch (e) { console.error(e); } });
            this.scheduleAutosave();
        }

        // ---------- id generation ----------
        nextId(type) {
            const prefix = ID_PREFIX[type] || 'X';
            if (!this.counters[type]) this.counters[type] = 0;
            let id;
            do {
                this.counters[type]++;
                id = prefix + this.counters[type];
            } while (this.findAny(id));
            return id;
        }

        findAny(id) {
            return this.getNode(id) || this.getLink(id) || this.getSubcatchment(id) || null;
        }

        // ---------- accessors ----------
        getNode(id) { return this.nodes.find(n => n.id === id); }
        getLink(id) { return this.links.find(l => l.id === id); }
        getSubcatchment(id) { return this.subcatchments.find(s => s.id === id); }
        get realNodes() { return this.nodes.filter(n => n.type !== 'RAINGAGE'); } // rain gages aren't hydraulic nodes
        get nodeCount() { return this.realNodes.length; }
        get linkCount() { return this.links.length; }

        // ---------- mutations (each commits a snapshot) ----------
        addNode(type, lngLat) {
            const node = {
                id: this.nextId(type),
                type: type,
                lngLat: [lngLat[0], lngLat[1]],
                props: defaultNodeProps(type)
            };
            this.nodes.push(node);
            this.commit();
            this.emit();
            return node;
        }

        addLink(type, fromId, toId, vertices) {
            const link = {
                id: this.nextId(type),
                type: type,
                from: fromId,
                to: toId,
                vertices: vertices || [], // intermediate points only
                props: defaultLinkProps(type)
            };
            if (type === 'CONDUIT') this.updateConduitLength(link);
            this.links.push(link);
            this.commit();
            this.emit();
            return link;
        }

        addSubcatchment(ring) {
            const sub = {
                id: this.nextId('SUBCATCHMENT'),
                ring: ring.map(c => [c[0], c[1]]), // open ring (no closing dup)
                props: defaultSubcatchProps()
            };
            // auto-compute area in hectares (SI) / acres (US)
            const m2 = ringAreaM2(sub.ring);
            sub.props.area = this.units === 'US'
                ? +(m2 / 4046.86).toFixed(3)
                : +(m2 / 10000).toFixed(3);
            // default raingage: first gage placed, else RG1
            const gage = this.nodes.find(n => n.type === 'RAINGAGE');
            if (gage) sub.props.raingage = gage.id;
            // default outlet: nearest hydraulic node to centroid
            const c = this.ringCentroid(sub.ring);
            const nearest = this.nearestNode(c, Infinity);
            if (nearest) sub.props.outlet = nearest.id;
            this.subcatchments.push(sub);
            this.commit();
            this.emit();
            return sub;
        }

        ringCentroid(ring) {
            let x = 0, y = 0;
            ring.forEach(p => { x += p[0]; y += p[1]; });
            return [x / ring.length, y / ring.length];
        }

        nearestNode(lngLat, maxMeters) {
            let best = null, bestD = Infinity;
            this.realNodes.forEach(n => {
                const d = haversine(lngLat, n.lngLat);
                if (d < bestD) { bestD = d; best = n; }
            });
            return (best && bestD <= maxMeters) ? best : null;
        }

        linkPathCoords(link) {
            const from = this.getNode(link.from);
            const to = this.getNode(link.to);
            if (!from || !to) return null;
            return [from.lngLat, ...link.vertices, to.lngLat];
        }

        updateConduitLength(link) {
            if (link.type !== 'CONDUIT' || !link.props.autoLength) return;
            const path = this.linkPathCoords(link);
            if (!path) return;
            const m = pathLengthMeters(path);
            link.props.length = this.units === 'US' ? +(m * 3.28084).toFixed(2) : +m.toFixed(2);
        }

        moveNode(id, lngLat, commit = true) {
            const node = this.getNode(id);
            if (!node) return;
            node.lngLat = [lngLat[0], lngLat[1]];
            this.links.forEach(l => {
                if (l.from === id || l.to === id) this.updateConduitLength(l);
            });
            if (commit) { this.commit(); }
            this.emit();
        }

        updateProps(id, updates) {
            const el = this.findAny(id);
            if (!el) return;
            Object.assign(el.props, updates);
            if (el.type === 'CONDUIT') this.updateConduitLength(el);
            this.commit();
            this.emit();
        }

        renameElement(oldId, newId) {
            newId = String(newId).trim().replace(/\s+/g, '_');
            if (!newId || newId === oldId) return oldId;
            if (this.findAny(newId)) return oldId; // must stay unique
            const el = this.findAny(oldId);
            if (!el) return oldId;
            el.id = newId;
            // fix references
            this.links.forEach(l => {
                if (l.from === oldId) l.from = newId;
                if (l.to === oldId) l.to = newId;
            });
            this.subcatchments.forEach(s => {
                if (s.props.outlet === oldId) s.props.outlet = newId;
                if (s.props.raingage === oldId) s.props.raingage = newId;
            });
            this.commit();
            this.emit();
            return newId;
        }

        deleteElements(ids) {
            const idSet = new Set(ids);
            // cascade: links attached to deleted nodes
            this.links.forEach(l => {
                if (idSet.has(l.from) || idSet.has(l.to)) idSet.add(l.id);
            });
            this.nodes = this.nodes.filter(n => !idSet.has(n.id));
            this.links = this.links.filter(l => !idSet.has(l.id));
            this.subcatchments = this.subcatchments.filter(s => !idSet.has(s.id));
            // clear dangling outlet refs
            this.subcatchments.forEach(s => {
                if (s.props.outlet && idSet.has(s.props.outlet)) s.props.outlet = '';
                if (s.props.raingage && idSet.has(s.props.raingage)) s.props.raingage = 'RG1';
            });
            this.commit();
            this.emit();
        }

        setUnits(units) {
            this.units = units === 'US' ? 'US' : 'SI';
            // recompute auto lengths/areas in the new unit system
            this.links.forEach(l => this.updateConduitLength(l));
            this.commit();
            this.emit();
        }

        // ---------- undo / redo ----------
        serialize() {
            return {
                version: 1,
                title: this.title,
                units: this.units,
                options: this.options,
                counters: this.counters,
                nodes: this.nodes,
                links: this.links,
                subcatchments: this.subcatchments,
                mesh2D: this.mesh2D, // Added for 2D mesh
                rawSections: this.rawSections
            };
        }

        loadState(state, resetHistory = false) {
            this.title = state.title || 'Untitled SWMM Project';
            this.units = state.units || 'SI';
            this.options = Object.assign(defaultOptions(), state.options || {});
            this.counters = state.counters || {};
            this.nodes = state.nodes || [];
            this.links = state.links || [];
            this.subcatchments = state.subcatchments || [];
            this.mesh2D = state.mesh2D || []; // Added for 2D mesh
            this.rawSections = state.rawSections || {};
            if (resetHistory) {
                this.history = [];
                this.hIndex = -1;
                this.commit();
            }
            this.emit();
        }

        commit() {
            const snap = JSON.stringify(this.serialize());
            // skip no-op commits
            if (this.hIndex >= 0 && this.history[this.hIndex] === snap) return;
            this.history = this.history.slice(0, this.hIndex + 1);
            this.history.push(snap);
            if (this.history.length > 100) this.history.shift();
            this.hIndex = this.history.length - 1;
        }

        get canUndo() { return this.hIndex > 0; }
        get canRedo() { return this.hIndex < this.history.length - 1; }

        undo() {
            if (!this.canUndo) return;
            this.hIndex--;
            this.loadState(JSON.parse(this.history[this.hIndex]));
        }

        redo() {
            if (!this.canRedo) return;
            this.hIndex++;
            this.loadState(JSON.parse(this.history[this.hIndex]));
        }

        // ---------- persistence ----------
        scheduleAutosave() {
            clearTimeout(this._saveTimer);
            this._saveTimer = setTimeout(() => {
                try {
                    localStorage.setItem('openswmm3d.project', JSON.stringify(this.serialize()));
                } catch (e) { /* storage full or unavailable */ }
            }, 400);
        }

        loadFromLocalStorage() {
            try {
                const raw = localStorage.getItem('openswmm3d.project');
                if (!raw) return false;
                const state = JSON.parse(raw);
                if (!state.nodes || !state.nodes.length) {
                    if (!state.links || !state.links.length) return false;
                }
                this.loadState(state, true);
                return true;
            } catch (e) {
                return false;
            }
        }

        downloadProject() {
            const blob = new Blob([JSON.stringify(this.serialize(), null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = (this.title.replace(/\s+/g, '_') || 'network') + '.oswmm.json';
            a.click();
            URL.revokeObjectURL(a.href);
        }

        // ---------- GeoJSON for map rendering ----------
        nodesGeoJSON() {
            return {
                type: 'FeatureCollection',
                features: this.nodes.map(n => ({
                    type: 'Feature',
                    id: n.id,
                    properties: { id: n.id, type: n.type },
                    geometry: { type: 'Point', coordinates: n.lngLat }
                }))
            };
        }

        linksGeoJSON() {
            const feats = [];
            this.links.forEach(l => {
                const path = this.linkPathCoords(l);
                if (!path) return;
                feats.push({
                    type: 'Feature',
                    id: l.id,
                    properties: { id: l.id, type: l.type },
                    geometry: { type: 'LineString', coordinates: path }
                });
            });
            return { type: 'FeatureCollection', features: feats };
        }

        subcatchmentsGeoJSON() {
            return {
                type: 'FeatureCollection',
                features: this.subcatchments.map(s => {
                    const ring = [...s.ring];
                    if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
                        ring.push([...ring[0]]);
                    }
                    return {
                        type: 'Feature',
                        id: s.id,
                        properties: { id: s.id, type: 'SUBCATCHMENT' },
                        geometry: { type: 'Polygon', coordinates: [ring] }
                    };
                })
            };
        }

        mesh2DGeoJSON() {
            return {
                type: 'FeatureCollection',
                features: this.mesh2D.map(m => {
                    const ring = [...m.ring];
                    if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
                        ring.push([...ring[0]]);
                    }
                    return {
                        type: 'Feature',
                        id: m.id, // For feature-state binding
                        properties: { id: m.id, type: 'MESH2D' },
                        geometry: { type: 'Polygon', coordinates: [ring] }
                    };
                })
            };
        }

        bounds() {
            const coords = [];
            this.nodes.forEach(n => coords.push(n.lngLat));
            this.links.forEach(l => l.vertices.forEach(v => coords.push(v)));
            this.subcatchments.forEach(s => s.ring.forEach(c => coords.push(c)));
            this.mesh2D.forEach(m => m.ring.forEach(c => coords.push(c))); // Included mesh in bounds
            if (!coords.length) return null;
            return coords;
        }
    }

    window.Net = new Network();
    window.NetworkGeom = { haversine, pathLengthMeters, ringAreaM2 };
    window.NET_NODE_TYPES = NODE_TYPES;
    window.NET_LINK_TYPES = LINK_TYPES;
})();
