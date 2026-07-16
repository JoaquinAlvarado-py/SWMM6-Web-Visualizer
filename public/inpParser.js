// inpParser.js — Parse a SWMM .inp file into a Network-model shape
// Coordinates are returned raw (may be UTM/local); the caller
// reprojects before loading into the Network.

class InpParser {

    parse(text) {
        const sections = {};
        const rawSections = {};
        const lines = text.split(/\r?\n/);
        let current = null;

        for (let line of lines) {
            let cleanLine = line.replace(/;.*$/, '').trim(); // strip inline comments
            if (cleanLine.startsWith('[') && cleanLine.endsWith(']')) {
                current = cleanLine.substring(1, cleanLine.length - 1).toUpperCase();
                if (!sections[current]) sections[current] = [];
                if (!rawSections[current]) rawSections[current] = [];
            } else if (current) {
                if (cleanLine) sections[current].push(cleanLine.split(/\s+/));
                rawSections[current].push(line);
            }
        }
        this.sections = sections;
        this.rawSections = rawSections;
        return this.buildModel();
    }

    num(v, fallback = 0) {
        const n = parseFloat(v);
        return isNaN(n) ? fallback : n;
    }

    buildModel() {
        const S = this.sections;
        const model = {
            title: (S['TITLE'] || []).map(r => r.join(' ')).join(' ').trim() || 'Imported SWMM Project',
            units: 'SI',
            options: {},
            nodes: [],
            links: [],
            subcatchments: [],
            mesh2D: [], // Added for 2D OpenSWMM engine
            rawSections: this.rawSections
        };

        // --- OPTIONS ---
        (S['OPTIONS'] || []).forEach(row => {
            const key = (row[0] || '').toUpperCase();
            const val = row.slice(1).join(' ');
            switch (key) {
                case 'FLOW_UNITS':
                    model.units = ['CFS', 'GPM', 'MGD'].includes(val.toUpperCase()) ? 'US' : 'SI';
                    model.options.flowUnits = val.toUpperCase();
                    break;
                case 'INFILTRATION': model.options.infiltration = val; break;
                case 'FLOW_ROUTING': model.options.flowRouting = val; break;
                case 'START_DATE': model.options.startDate = val; break;
                case 'START_TIME': model.options.startTime = val; break;
                case 'END_DATE': model.options.endDate = val; break;
                case 'END_TIME': model.options.endTime = val; break;
                case 'REPORT_STEP': model.options.reportStep = val; break;
                case 'WET_STEP': model.options.wetStep = val; break;
                case 'DRY_STEP': model.options.dryStep = val; break;
                case 'ROUTING_STEP': model.options.routingStep = val; break;
            }
        });

        // --- Coordinates lookup ---
        const coords = {};
        (S['COORDINATES'] || []).forEach(row => {
            if (row.length >= 3) coords[row[0]] = [this.num(row[1]), this.num(row[2])];
        });

        // --- Nodes ---
        (S['JUNCTIONS'] || []).forEach(row => {
            if (!coords[row[0]]) return;
            model.nodes.push({
                id: row[0], type: 'JUNCTION', lngLat: coords[row[0]],
                props: {
                    invertEl: this.num(row[1]), maxDepth: this.num(row[2]),
                    initDepth: this.num(row[3]), surDepth: this.num(row[4]), aponded: this.num(row[5])
                }
            });
        });

        (S['OUTFALLS'] || []).forEach(row => {
            if (!coords[row[0]]) return;
            const type = (row[2] || 'FREE').toUpperCase();
            const hasStage = ['FIXED', 'TIDAL', 'TIMESERIES'].includes(type);
            model.nodes.push({
                id: row[0], type: 'OUTFALL', lngLat: coords[row[0]],
                props: {
                    invertEl: this.num(row[1]), outfallType: type,
                    stageData: hasStage ? (row[3] || '') : '',
                    gated: (hasStage ? row[4] : row[3]) || 'NO'
                }
            });
        });

        (S['STORAGE'] || []).forEach(row => {
            if (!coords[row[0]]) return;
            model.nodes.push({
                id: row[0], type: 'STORAGE', lngLat: coords[row[0]],
                props: {
                    invertEl: this.num(row[1]), maxDepth: this.num(row[2]), initDepth: this.num(row[3]),
                    shape: (row[4] || 'FUNCTIONAL').toUpperCase(),
                    coeff: this.num(row[5], 1000), exponent: this.num(row[6]), constant: this.num(row[7])
                }
            });
        });

        (S['DIVIDERS'] || []).forEach(row => {
            if (!coords[row[0]]) return;
            model.nodes.push({
                id: row[0], type: 'DIVIDER', lngLat: coords[row[0]],
                props: {
                    invertEl: this.num(row[1]), divertedLink: row[2] || '',
                    dividerType: (row[3] || 'CUTOFF').toUpperCase(),
                    param: this.num(row[4]), maxDepth: this.num(row[5], 2)
                }
            });
        });

        // --- Rain gages (placed via [SYMBOLS] if present) ---
        const symbols = {};
        (S['SYMBOLS'] || []).forEach(row => {
            if (row.length >= 3) symbols[row[0]] = [this.num(row[1]), this.num(row[2])];
        });
        (S['RAINGAGES'] || []).forEach(row => {
            const pos = symbols[row[0]];
            if (!pos) return; // gage without map position — kept implicit
            model.nodes.push({
                id: row[0], type: 'RAINGAGE', lngLat: pos,
                props: {
                    format: (row[1] || 'INTENSITY').toUpperCase(), interval: row[2] || '1:00',
                    scf: this.num(row[3], 1.0),
                    sourceType: (row[4] || 'TIMESERIES').toUpperCase(), sourceName: row[5] || 'TS1'
                }
            });
        });

        // --- Link vertices ---
        const vertices = {};
        (S['VERTICES'] || []).forEach(row => {
            if (row.length < 3) return;
            if (!vertices[row[0]]) vertices[row[0]] = [];
            vertices[row[0]].push([this.num(row[1]), this.num(row[2])]);
        });

        const nodeIds = new Set(model.nodes.map(n => n.id));
        const pushLink = (row, type, props) => {
            if (!nodeIds.has(row[1]) || !nodeIds.has(row[2])) return;
            model.links.push({
                id: row[0], type, from: row[1], to: row[2],
                vertices: vertices[row[0]] || [], props
            });
        };

        (S['CONDUITS'] || []).forEach(row => pushLink(row, 'CONDUIT', {
            length: this.num(row[3], 100), autoLength: false, roughness: this.num(row[4], 0.013),
            inOffset: this.num(row[5]), outOffset: this.num(row[6]),
            initFlow: this.num(row[7]), maxFlow: this.num(row[8]),
            xShape: 'CIRCULAR', geom1: 1.0, geom2: 0, geom3: 0, geom4: 0, barrels: 1
        }));

        (S['PUMPS'] || []).forEach(row => pushLink(row, 'PUMP', {
            pumpCurve: row[3] || '*', status: (row[4] || 'ON').toUpperCase(),
            startup: this.num(row[5]), shutoff: this.num(row[6])
        }));

        (S['WEIRS'] || []).forEach(row => pushLink(row, 'WEIR', {
            weirType: (row[3] || 'TRANSVERSE').toUpperCase(), crestHt: this.num(row[4]),
            qCoeff: this.num(row[5], 3.33), gated: (row[6] || 'NO').toUpperCase(),
            xShape: 'RECT_OPEN', geom1: 1.0, geom2: 1.0, geom3: 0, geom4: 0
        }));

        (S['ORIFICES'] || []).forEach(row => pushLink(row, 'ORIFICE', {
            orificeType: (row[3] || 'SIDE').toUpperCase(), offset: this.num(row[4]),
            qCoeff: this.num(row[5], 0.65), gated: (row[6] || 'NO').toUpperCase(),
            xShape: 'CIRCULAR', geom1: 1.0, geom2: 0, geom3: 0, geom4: 0
        }));

        // --- Cross sections applied onto links ---
        const linkById = {};
        model.links.forEach(l => linkById[l.id] = l);
        (S['XSECTIONS'] || []).forEach(row => {
            const l = linkById[row[0]];
            if (!l) return;
            l.props.xShape = (row[1] || 'CIRCULAR').toUpperCase();
            l.props.geom1 = this.num(row[2], 1);
            l.props.geom2 = this.num(row[3]);
            l.props.geom3 = this.num(row[4]);
            l.props.geom4 = this.num(row[5]);
            l.props.barrels = this.num(row[6], 1);
        });

        // --- Subcatchments ---
        const polygons = {};
        (S['POLYGONS'] || []).forEach(row => {
            if (row.length < 3) return;
            if (!polygons[row[0]]) polygons[row[0]] = [];
            polygons[row[0]].push([this.num(row[1]), this.num(row[2])]);
        });

        (S['SUBCATCHMENTS'] || []).forEach(row => {
            const ring = polygons[row[0]];
            if (!ring || ring.length < 3) return;
            model.subcatchments.push({
                id: row[0],
                ring: ring,
                props: {
                    raingage: row[1] || 'RG1', outlet: row[2] || '',
                    area: this.num(row[3], 10), autoArea: false,
                    imperv: this.num(row[4], 50), width: this.num(row[5], 500),
                    slope: this.num(row[6], 0.5), curbLen: this.num(row[7])
                }
            });
        });

        // --- 2D Mesh (OpenSWMM Engine) ---
        const meshVertices = {};
        (S['2D_VERTICES'] || []).forEach(row => {
            if (row.length >= 3) meshVertices[row[0]] = [this.num(row[1]), this.num(row[2])];
        });

        (S['2D_CELLS'] || []).forEach(row => {
            if (row.length < 4) return; // Need ID and at least 3 vertices
            const cellId = row[0];
            const ring = [];
            let valid = true;
            for (let i = 1; i < row.length; i++) {
                const vId = row[i];
                if (meshVertices[vId]) {
                    ring.push(meshVertices[vId]);
                } else {
                    valid = false;
                }
            }
            if (valid && ring.length >= 3) {
                // Ensure polygon is closed for GeoJSON
                if (ring[0][0] !== ring[ring.length-1][0] || ring[0][1] !== ring[ring.length-1][1]) {
                    ring.push([...ring[0]]);
                }
                model.mesh2D.push({
                    id: cellId,
                    ring: ring
                });
            }
        });

        return model;
    }
}

window.inpParser = new InpParser();
