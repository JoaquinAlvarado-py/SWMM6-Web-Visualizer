// results.js — Parse SWMM .rpt output, populate the Results
// panel, and color-code the network on the map.

(function () {
    'use strict';

    // color ramp (low → high)
    const RAMP = ['#2e7dd1', '#26a69a', '#ffca28', '#f57c00', '#d32f2f'];

    function lerpColor(c1, c2, t) {
        const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
        const a = p(c1), b = p(c2);
        const m = a.map((v, i) => Math.round(v + (b[i] - v) * t));
        return `rgb(${m[0]},${m[1]},${m[2]})`;
    }

    function rampColor(t) {
        t = Math.max(0, Math.min(1, t));
        const seg = t * (RAMP.length - 1);
        const i = Math.min(Math.floor(seg), RAMP.length - 2);
        return lerpColor(RAMP[i], RAMP[i + 1], seg - i);
    }
    window.rampColor = rampColor; // used by street_view_overlay.js

    // min/max via loop — Math.min(...arr) overflows the stack on >100k elements
    function arrayMinMax(arr) {
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < arr.length; i++) {
            const v = arr[i];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        return { min, max };
    }

    // ---------- rpt parsing ----------
    // All parsers take the pre-split lines array — the report is split ONCE
    // in displayResults instead of 8+ times.
    function sectionLines(lines, title) {
        const i = lines.findIndex(l => l.includes(title));
        if (i === -1) return null;
        const out = [];
        for (let j = i + 1; j < lines.length; j++) {
            const t = lines[j].trim();
            if (/^\*{4,}$/.test(t)) {
                if (j === i + 1) continue; // closing underline of this section's own title
                break;                     // start of the next section header
            }
            out.push(lines[j]);
        }
        return out;
    }

    function parseNodeDepths(lines0) {
        const lines = sectionLines(lines0, 'Node Depth Summary');
        if (!lines) return {};
        const out = {};
        for (const line of lines) {
            const m = line.match(/^\s{0,4}(\S+)\s+(JUNCTION|OUTFALL|STORAGE|DIVIDER)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/);
            if (m) out[m[1]] = { type: m[2], avgDepth: parseFloat(m[3]), maxDepth: parseFloat(m[4]) };
        }
        return out;
    }

    function parseLinkFlows(lines0) {
        const lines = sectionLines(lines0, 'Link Flow Summary');
        if (!lines) return {};
        const out = {};
        for (const line of lines) {
            const m = line.match(/^\s{0,4}(\S+)\s+(CONDUIT|PUMP|WEIR|ORIFICE|CHANNEL|DUMMY)\s+([\d.eE+-]+)/);
            if (m) out[m[1]] = { type: m[2], maxFlow: parseFloat(m[3]) };
        }
        return out;
    }

    function parseFlooding(lines0) {
        const lines = sectionLines(lines0, 'Node Flooding Summary');
        if (!lines) return [];
        const out = [];
        for (const line of lines) {
            if (line.includes('---')) continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 6 && parts[0] !== 'Node' && !isNaN(parts[1])) {
                if (Net.getNode(parts[0])) {
                    out.push({
                        id: parts[0],
                        hoursFlooded: parts[1],
                        maxRate: parts[2],
                        totalFloodVol: parts[5],
                        maxPondedVol: parts[6] || '0'
                    });
                }
            }
        }
        return out;
    }

    function parseNodeInflows(lines0) {
        const lines = sectionLines(lines0, 'Node Inflow Summary');
        if (!lines) return [];
        const out = [];
        for (const line of lines) {
            if (line.includes('---')) continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 9 && ['JUNCTION','OUTFALL','STORAGE','DIVIDER'].includes(parts[1])) {
                out.push({
                    id: parts[0],
                    type: parts[1],
                    maxLatInflow: parts[2],
                    maxTotalInflow: parts[3],
                    latInflowVol: parts[parts.length - 3],
                    totalInflowVol: parts[parts.length - 2],
                    flowBalError: parts[parts.length - 1]
                });
            }
        }
        return out;
    }

    function parseOutfallLoadings(lines0) {
        const lines = sectionLines(lines0, 'Outfall Loading Summary');
        if (!lines) return [];
        const out = [];
        for (const line of lines) {
            if (line.includes('---')) continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5 && parts[0] !== 'Outfall' && parts[0] !== 'System' && !isNaN(parts[1])) {
                out.push({
                    id: parts[0],
                    flowFreq: parts[1],
                    avgFlow: parts[2],
                    maxFlow: parts[3],
                    totalVolume: parts[4]
                });
            }
        }
        return out;
    }

    function parseConduitSurcharges(lines0) {
        const lines = sectionLines(lines0, 'Conduit Surcharge Summary');
        if (!lines) return [];
        const out = [];
        for (const line of lines) {
            if (line.includes('---')) continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 6 && parts[0] !== 'Conduit' && !isNaN(parts[1])) {
                out.push({
                    id: parts[0],
                    bothEnds: parts[1],
                    upstream: parts[2],
                    dnstream: parts[3],
                    aboveNormal: parts[4],
                    capacityLimited: parts[5]
                });
            }
        }
        return out;
    }

    function parseSubcatchmentRunoffs(lines0) {
        const lines = sectionLines(lines0, 'Subcatchment Runoff Summary');
        if (!lines) return [];
        const out = [];
        for (const line of lines) {
            if (line.includes('---')) continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 9 && parts[0] !== 'Subcatchment' && !isNaN(parts[1])) {
                out.push({
                    id: parts[0],
                    totalPrecip: parts[1],
                    totalRunon: parts[2],
                    totalEvap: parts[3],
                    totalInfil: parts[4],
                    totalRunoff: parts[5],
                    totalRunoffVol: parts[6],
                    peakRunoff: parts[7],
                    runoffCoeff: parts[8]
                });
            }
        }
        return out;
    }

    function parseFlowClassifications(lines0) {
        const lines = sectionLines(lines0, 'Flow Classification Summary');
        if (!lines) return [];
        const out = [];
        for (const line of lines) {
            if (line.includes('---')) continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 10 && parts[0] !== 'Conduit' && !isNaN(parts[1])) {
                out.push({
                    id: parts[0],
                    adjLength: parts[1],
                    upDry: parts[2],
                    downDry: parts[3],
                    subCrit: parts[4],
                    supCrit: parts[5],
                    upCrit: parts[6],
                    downCrit: parts[7],
                    normLtd: parts[8],
                    avgFroude: parts[9],
                    avgFlow: parts[10] || '0'
                });
            }
        }
        return out;
    }

    function parseContinuityErrors(rpt) {
        const out = [];
        const re = /Continuity Error \(%\)[ .]*(-?[\d.eE+-]+)/g;
        let m;
        while ((m = re.exec(rpt)) !== null) out.push(parseFloat(m[1]));
        return out;
    }

    function parseEngineErrors(lines0) {
        return lines0
            .filter(l => /^\s*(ERROR|WARNING)\b/i.test(l.trim()))
            .map(l => l.trim())
            .slice(0, 8);
    }

    // ---------- time-series parsing ----------
    function parseTimeSeries(rptLines) {
        const out = {
            times: [], // array of "Date Time" strings
            nodes: {}, // id -> array of depth values
            links: {},  // id -> array of flow values
            nodeMax: {},
            linkMax: {}
        };

        const lines = rptLines;
        let currentType = null; // 'node' or 'link' or 'cell'
        let currentId = null;
        let timeIndexMap = {}; 
        let nextTimeIndex = 0;
        
        let state = 0; // 0=seek, 1=wait header, 2=data

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (line.startsWith('<<< Node ')) {
                const match = line.match(/<<< Node (.*?) >>>/);
                if (match) {
                    currentId = match[1].trim();
                    currentType = 'node';
                    out.nodes[currentId] = { inflow: [], flooding: [], depth: [], head: [] };
                    state = 1;
                }
                continue;
            } else if (line.startsWith('<<< Cell ')) {
                const match = line.match(/<<< Cell (.*?) >>>/);
                if (match) {
                    currentId = match[1].trim();
                    currentType = 'cell';
                    out.nodes[currentId] = { depth: [], head: [] };
                    state = 1;
                }
                continue;
            } else if (line.startsWith('<<< Link ')) {
                const match = line.match(/<<< Link (.*?) >>>/);
                if (match) {
                    currentId = match[1].trim();
                    currentType = 'link';
                    out.links[currentId] = { flow: [], velocity: [], depth: [], capacity: [] };
                    state = 1;
                }
                continue;
            }
            
            if (state === 1) {
                // Wait for the second dashed line before data
                if (line.startsWith('---') && lines[i-1] && lines[i-1].includes('Time')) {
                    state = 2;
                }
            } else if (state === 2) {
                if (line.length === 0) {
                    state = 0;
                    continue;
                }
                const parts = line.split(/\s+/);
                
                let dateStr, timeStr, dataStartIdx;
                if (parts[0] && parts[0].includes(':')) {
                    dateStr = '0';
                    timeStr = parts[0];
                    dataStartIdx = 1;
                } else if (parts[1] && parts[1].includes(':')) {
                    dateStr = parts[0];
                    timeStr = parts[1];
                    dataStartIdx = 2;
                } else {
                    continue;
                }

                if (parts.length >= dataStartIdx + 1) {
                    const dt = dateStr + ' ' + timeStr;
                    let tIdx = timeIndexMap[dt];
                    if (tIdx === undefined) {
                        tIdx = nextTimeIndex++;
                        timeIndexMap[dt] = tIdx;
                        out.times.push(dt);
                    }
                    
                    let depthVal = 0;
                    if (currentType === 'node') {
                        out.nodes[currentId].inflow[tIdx] = parseFloat(parts[dataStartIdx]) || 0;
                        out.nodes[currentId].flooding[tIdx] = parseFloat(parts[dataStartIdx + 1]) || 0;
                        depthVal = parseFloat(parts[dataStartIdx + 2]) || 0;
                        out.nodes[currentId].depth[tIdx] = depthVal;
                        out.nodes[currentId].head[tIdx] = parseFloat(parts[dataStartIdx + 3]) || 0;
                        
                        if (!out.nodeMax[currentId] || depthVal > out.nodeMax[currentId]) {
                            out.nodeMax[currentId] = depthVal;
                        }
                    } else if (currentType === 'cell') {
                        depthVal = parseFloat(parts[dataStartIdx]) || 0;
                        out.nodes[currentId].depth[tIdx] = depthVal;
                        out.nodes[currentId].head[tIdx] = parseFloat(parts[dataStartIdx + 1]) || 0;
                        
                        if (!out.nodeMax[currentId] || depthVal > out.nodeMax[currentId]) {
                            out.nodeMax[currentId] = depthVal;
                        }
                    } else if (currentType === 'link') {
                        let flowVal = parseFloat(parts[dataStartIdx]) || 0;
                        out.links[currentId].flow[tIdx] = flowVal;
                        out.links[currentId].velocity[tIdx] = parseFloat(parts[dataStartIdx + 1]) || 0;
                        out.links[currentId].depth[tIdx] = parseFloat(parts[dataStartIdx + 2]) || 0;
                        out.links[currentId].capacity[tIdx] = parseFloat(parts[dataStartIdx + 3]) || 0;
                        
                        if (!out.linkMax[currentId] || Math.abs(flowVal) > out.linkMax[currentId]) {
                            out.linkMax[currentId] = Math.abs(flowVal);
                        }
                    }
                } else if (line.startsWith('<<<') || line.startsWith('---')) {
                    state = 0;
                }
            }
        }
        
        return out;
    }

    // ---------- map styling via feature-state resultColor ----------
    const ResultStyling = {
        active: false,
        nodeColors: {},   // id -> max color
        linkColors: {},   // id -> max color
        timeSeries: null, // parsed time series data
        nodeMinMax: { min: 0, max: 0.1 },
        linkMinMax: { min: 0, max: 0.1 },
        currentStep: 0,
        // dirty-tracking: last color pushed via setFeatureState, per element
        _appliedNode: new Map(),
        _appliedLink: new Map(),

        applyToMap() {
            Object.entries(this.nodeColors).forEach(([id, color]) => {
                if (this._appliedNode.get(id) === color) return;
                this._appliedNode.set(id, color);
                try { map.setFeatureState({ source: 'swmm-nodes', id }, { resultColor: color }); } catch (e) { }
                try { map.setFeatureState({ source: 'swmm-2d-mesh', id }, { resultColor: color }); } catch (e) { }
            });
            Object.entries(this.linkColors).forEach(([id, color]) => {
                if (this._appliedLink.get(id) === color) return;
                this._appliedLink.set(id, color);
                try { map.setFeatureState({ source: 'swmm-links', id }, { resultColor: color }); } catch (e) { }
            });
        },

        applyToMapForStep(step) {
            if (!this.active || !this.timeSeries) return;
            const ts = this.timeSeries;
            this.currentStep = step;
            if (step < 0 || step >= ts.times.length) return;

            const nMin = this.nodeMinMax.min, nMax = this.nodeMinMax.max;
            const lMin = this.linkMinMax.min, lMax = this.linkMinMax.max;

            Object.entries(ts.nodes).forEach(([id, values]) => {
                const val = values.depth ? values.depth[step] : undefined;
                if (val !== undefined) {
                    const t = nMax > nMin ? (val - nMin) / (nMax - nMin) : 0.5;
                    const color = rampColor(t);
                    // Only touch the map when the color actually changed
                    if (this._appliedNode.get(id) === color) return;
                    this._appliedNode.set(id, color);
                    try { map.setFeatureState({ source: 'swmm-nodes', id }, { resultColor: color }); } catch (e) { }
                    try { map.setFeatureState({ source: 'swmm-2d-mesh', id }, { resultColor: color }); } catch (e) { }
                }
            });

            Object.entries(ts.links).forEach(([id, values]) => {
                const val = values.flow ? values.flow[step] : undefined;
                if (val !== undefined) {
                    const t = lMax > lMin ? (Math.abs(val) - lMin) / (lMax - lMin) : 0.5;
                    const color = rampColor(t);
                    if (this._appliedLink.get(id) === color) return;
                    this._appliedLink.set(id, color);
                    try { map.setFeatureState({ source: 'swmm-links', id }, { resultColor: color }); } catch (e) { }
                }
            });
            
            // Also update the UI time display safely if needed
            const timeDisplay = document.getElementById('time-display');
            if (timeDisplay && ts.times[step]) {
                timeDisplay.textContent = `Time: ${ts.times[step]}`;
            }

            if (window.StreetViewOverlay && window.StreetViewOverlay.scheduleRedraw) {
                window.StreetViewOverlay.scheduleRedraw();
            }
        },

        clear() {
            this.active = false;
            // Clear every element we ever pushed a color to (applyToMapForStep
            // may have touched ids beyond nodeColors/linkColors)
            const nodeIds = new Set([...Object.keys(this.nodeColors), ...this._appliedNode.keys()]);
            const linkIds = new Set([...Object.keys(this.linkColors), ...this._appliedLink.keys()]);
            nodeIds.forEach(id => {
                try { map.setFeatureState({ source: 'swmm-nodes', id }, { resultColor: null }); } catch (e) { }
                try { map.setFeatureState({ source: 'swmm-2d-mesh', id }, { resultColor: null }); } catch (e) { }
            });
            linkIds.forEach(id => {
                try { map.setFeatureState({ source: 'swmm-links', id }, { resultColor: null }); } catch (e) { }
            });
            this._appliedNode.clear();
            this._appliedLink.clear();
            this.nodeColors = {};
            this.linkColors = {};
            this.timeSeries = null;
            if (window.AnimationUI) window.AnimationUI.hide();
        }
    };
    window.ResultStyling = ResultStyling;

    // ---------- Results panel rendering ----------
    function el(html) {
        const div = document.createElement('div');
        div.innerHTML = html.trim();
        return div.firstChild;
    }

    function esc(s) {
        return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function legendBlock(title, minV, maxV, unit) {
        const stops = [0, 0.25, 0.5, 0.75, 1];
        const rows = stops.map(t => {
            const v = (minV + (maxV - minV) * t);
            return `<div class="legend-row"><span class="legend-swatch" style="background:${rampColor(t)}"></span><span>${v.toFixed(2)} ${unit}</span></div>`;
        }).join('');
        return `<div class="results-block"><h4>${esc(title)}</h4>${rows}</div>`;
    }

    function tableBlock(title, headers, rows) {
        const head = headers.map(h => `<th>${esc(h)}</th>`).join('');
        const body = rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
        return `<div class="results-block"><h4>${esc(title)}</h4><table class="results-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }

    window.showResultsWarning = function (msg) {
        const container = document.getElementById('results-content');
        container.innerHTML = `<div class="results-warning">${esc(msg)}</div>`;
        if (window.openResultsPanel) window.openResultsPanel();
    };

    window.clearResults = function () {
        ResultStyling.clear();
        const container = document.getElementById('results-content');
        if (container) container.innerHTML = '';
        const hint = document.getElementById('results-hint');
        if (hint) hint.classList.remove('hidden');
        const select = document.getElementById('results-category-select');
        if (select) select.classList.add('hidden');
        window.App.lastRunReport = null;
        window.App.outData = null;
    };

    window.displayResults = function (rpt, outData) {
        const container = document.getElementById('results-content');
        const hint = document.getElementById('results-hint');
        const select = document.getElementById('results-category-select');
        
        if (hint) hint.classList.add('hidden');
        container.innerHTML = '';

        // split the report ONCE; every parser works on the same lines array
        const rptLines = rpt.split('\n');
        const errors = parseEngineErrors(rptLines);
        const depths = parseNodeDepths(rptLines);
        const flows = parseLinkFlows(rptLines);
        const contErrors = parseContinuityErrors(rpt);
        
        const summaryData = {
            'Node Depth': depths,
            'Link Flow': flows,
            'Node Inflow': parseNodeInflows(rptLines),
            'Node Flooding': parseFlooding(rptLines),
            'Outfall Loading': parseOutfallLoadings(rptLines),
            'Conduit Surcharge': parseConduitSurcharges(rptLines),
            'Subcatchment Runoff': parseSubcatchmentRunoffs(rptLines),
            'Flow Classification': parseFlowClassifications(rptLines)
        };

        const isUS = Net.units === 'US';
        const depthUnit = isUS ? 'ft' : 'm';
        const flowUnit  = isUS ? 'CFS' : 'LPS';
        const areaUnit  = isUS ? 'ac'  : 'ha';
        const volUnit   = isUS ? 'Mgal': 'ML';

        // ---- color-code the map ----
        ResultStyling.clear();
        const depthVals = Object.values(depths).map(d => d.maxDepth);
        const flowVals = Object.values(flows).map(f => f.maxFlow);

        let dMin = 0, dMax = 0, fMin = 0, fMax = 0;
        if (depthVals.length) {
            ({ min: dMin, max: dMax } = arrayMinMax(depthVals));
            ResultStyling.nodeMinMax = { min: dMin, max: dMax };
            Object.entries(depths).forEach(([id, d]) => {
                const t = dMax > dMin ? (d.maxDepth - dMin) / (dMax - dMin) : 0.5;
                ResultStyling.nodeColors[id] = rampColor(t);
            });
        }

        if (flowVals.length) {
            ({ min: fMin, max: fMax } = arrayMinMax(flowVals));
            ResultStyling.linkMinMax = { min: fMin, max: fMax };
            Object.entries(flows).forEach(([id, f]) => {
                const t = fMax > fMin ? (f.maxFlow - fMin) / (fMax - fMin) : 0.5;
                ResultStyling.linkColors[id] = rampColor(t);
            });
        }

        let ts = null;
        if (outData && outData.parsed && outData.numPeriods > 0) {
            ts = { times: [], nodes: {}, links: {}, nodeMax: {}, linkMax: {} };
            // SWMM epoch (1899-12-30); use UTC so historical timezone
            // offsets don't skew the wall-clock times stored in the file
            const epochUTC = Date.UTC(1899, 11, 30);
            for (let i = 0; i < outData.numPeriods; i++) {
                const t = outData.results.times[i];
                const d = new Date(epochUTC + Math.round(t * 86400000));
                const day = String(d.getUTCDate()).padStart(2, '0');
                const mon = String(d.getUTCMonth() + 1).padStart(2, '0');
                const hrs = String(d.getUTCHours()).padStart(2, '0');
                const mins = String(d.getUTCMinutes()).padStart(2, '0');
                const secs = String(d.getUTCSeconds()).padStart(2, '0');
                ts.times.push(`${mon}/${day}/${d.getUTCFullYear()} ${hrs}:${mins}:${secs}`);
            }
            outData.names.nodes.forEach((id, i) => {
                ts.nodes[id] = {
                    depth: outData.getTimeSeries('NODE', i, 0),
                    head: outData.getTimeSeries('NODE', i, 1),
                    inflow: outData.getTimeSeries('NODE', i, 4),
                    flooding: outData.getTimeSeries('NODE', i, 5)
                };
            });
            outData.names.links.forEach((id, i) => {
                ts.links[id] = {
                    flow: outData.getTimeSeries('LINK', i, 0),
                    depth: outData.getTimeSeries('LINK', i, 1),
                    velocity: outData.getTimeSeries('LINK', i, 2),
                    capacity: outData.getTimeSeries('LINK', i, 4)
                };
            });
        } else {
            ts = parseTimeSeries(rptLines);
        }
        
        if (ts && ts.times && ts.times.length > 0) {
            ResultStyling.timeSeries = ts;
            if (window.AnimationUI) {
                window.AnimationUI.setRange(ts.times.length);
                window.AnimationUI.show();
            }
        }

        ResultStyling.active = true;
        ResultStyling.applyToMap();
        
        // Populate dropdown
        let hasAny = false;
        const availableOptions = [];
        
        if (Object.keys(summaryData['Subcatchment Runoff']).length > 0) availableOptions.push('Subcatchment Runoff');
        if (Object.keys(summaryData['Node Depth']).length > 0) availableOptions.push('Node Depth');
        if (summaryData['Node Inflow'].length > 0) availableOptions.push('Node Inflow');
        if (summaryData['Node Flooding'].length > 0) availableOptions.push('Node Flooding');
        if (summaryData['Outfall Loading'].length > 0) availableOptions.push('Outfall Loading');
        if (Object.keys(summaryData['Link Flow']).length > 0) availableOptions.push('Link Flow');
        if (summaryData['Flow Classification'].length > 0) availableOptions.push('Flow Classification');
        if (summaryData['Conduit Surcharge'].length > 0) availableOptions.push('Conduit Surcharge');
        
        if (availableOptions.length > 0 && select) {
            select.innerHTML = '';
            select.classList.remove('hidden');
            availableOptions.forEach(opt => {
                const el = document.createElement('option');
                el.value = opt;
                el.textContent = opt;
                select.appendChild(el);
            });
            hasAny = true;
        } else if (select) {
            select.classList.add('hidden');
        }

        const renderCategory = () => {
            container.innerHTML = '';
            const cat = select ? select.value : 'Node Depth';
            
            if (errors.length) {
                container.innerHTML += `<div class="results-warning">${errors.map(esc).join('\n')}</div>`;
            }
            
            if (depthVals.length) {
                container.innerHTML += legendBlock(`Node Max Water Depth (${depthUnit})`, dMin, dMax, depthUnit);
            }
            if (flowVals.length) {
                container.innerHTML += legendBlock(`Link Peak Flow Rate (${flowUnit})`, fMin, fMax, flowUnit);
            }

            if (cat === 'Node Depth') {
                const rows = Object.entries(summaryData['Node Depth'])
                    .sort((a, b) => b[1].maxDepth - a[1].maxDepth).slice(0, 50)
                    .map(([id, d]) => [id, d.type, d.avgDepth.toFixed(3), d.maxDepth.toFixed(3)]);
                if (rows.length) container.innerHTML += tableBlock(
                    `Node Water Depth Summary (${depthUnit})`,
                    ['Node ID', 'Type', `Avg Depth (${depthUnit})`, `Max Depth (${depthUnit})`],
                    rows
                );
            } else if (cat === 'Link Flow') {
                const rows = Object.entries(summaryData['Link Flow'])
                    .sort((a, b) => b[1].maxFlow - a[1].maxFlow).slice(0, 50)
                    .map(([id, f]) => [id, f.type, f.maxFlow.toFixed(3)]);
                if (rows.length) container.innerHTML += tableBlock(
                    `Link Flow Rate Summary (${flowUnit})`,
                    ['Link ID', 'Type', `Peak Flow Rate (${flowUnit})`],
                    rows
                );
            } else if (cat === 'Node Inflow') {
                const rows = summaryData['Node Inflow'].map(d => [d.id, d.type, d.maxLatInflow, d.maxTotalInflow, d.latInflowVol, d.totalInflowVol, d.flowBalError]);
                if (rows.length) container.innerHTML += tableBlock(
                    `Node Inflow Summary (${flowUnit})`,
                    ['Node ID', 'Type', `Max Lat. Inflow (${flowUnit})`, `Max Total Inflow (${flowUnit})`, `Lat. Inflow Vol. (${volUnit})`, `Total Inflow Vol. (${volUnit})`, 'Flow Bal. Error (%)'],
                    rows
                );
            } else if (cat === 'Node Flooding') {
                const rows = summaryData['Node Flooding'].map(d => [d.id, d.hoursFlooded, d.maxRate, d.totalFloodVol || '—', d.maxPondedVol || '—']);
                if (rows.length) container.innerHTML += tableBlock(
                    `Node Flooding Summary (${flowUnit})`,
                    ['Node ID', 'Hours Flooded (hr)', `Max Flooding Rate (${flowUnit})`, `Total Flood Vol. (${volUnit})`, `Max Ponded Vol. (${volUnit})`],
                    rows
                );
            } else if (cat === 'Outfall Loading') {
                const rows = summaryData['Outfall Loading'].map(d => [d.id, d.flowFreq, d.avgFlow, d.maxFlow, d.totalVolume]);
                if (rows.length) container.innerHTML += tableBlock(
                    `Outfall Loading Summary`,
                    ['Outfall ID', 'Flow Freq. (%)', `Avg Flow Rate (${flowUnit})`, `Peak Flow Rate (${flowUnit})`, `Total Vol. (${volUnit})`],
                    rows
                );
            } else if (cat === 'Conduit Surcharge') {
                const rows = summaryData['Conduit Surcharge'].map(d => [d.id, d.bothEnds, d.upstream, d.dnstream, d.aboveNormal, d.capacityLimited]);
                if (rows.length) container.innerHTML += tableBlock(
                    `Conduit Surcharge Summary (hrs above full)`,
                    ['Conduit ID', 'Both Ends (hr)', 'Upstream (hr)', 'Downstream (hr)', 'Above Normal (hr)', 'Capacity-Ltd. (hr)'],
                    rows
                );
            } else if (cat === 'Subcatchment Runoff') {
                const rows = summaryData['Subcatchment Runoff'].map(d => [d.id, d.totalPrecip, d.totalRunon, d.totalEvap, d.totalInfil, d.totalRunoff, d.peakRunoff, d.runoffCoeff]);
                if (rows.length) container.innerHTML += tableBlock(
                    `Subcatchment Runoff Summary`,
                    ['Subcatchment ID', `Total Precip. (mm)`, `Runon (mm)`, `Evap. (mm)`, `Infiltr. (mm)`, `Total Runoff (mm)`, `Peak Runoff (${flowUnit})`, 'Runoff Coeff.'],
                    rows
                );
            } else if (cat === 'Flow Classification') {
                const rows = summaryData['Flow Classification'].map(d => [d.id, d.upDry, d.downDry, d.subCrit, d.supCrit, d.upCrit, d.downCrit, d.normLtd]);
                if (rows.length) container.innerHTML += tableBlock(
                    `Flow Classification Summary (fraction of time)`,
                    ['Conduit ID', 'Up Dry', 'Dn Dry', 'Sub-Critical', 'Super-Critical', 'Up-Critical', 'Dn-Critical', 'Norm. Limited'],
                    rows
                );
            }
            
            // ---- summary footer ----
            let summary = 'Simulation complete.';
            if (contErrors.length) {
                summary += `\nContinuity errors: ${contErrors.map(v => v.toFixed(2) + '%').join(', ')}`;
            }
            if (!depthVals.length && !flowVals.length && !hasAny) {
                summary += '\nNo summary tables found in the report — check the console for the full report text.';
            }
            summary += '\nFull report printed to browser console.';
            container.innerHTML += `<div class="results-summary">${esc(summary)}</div>`;
        };

        if (select) {
            select.onchange = renderCategory;
        }

        renderCategory();

        if (window.openResultsPanel) window.openResultsPanel();
    };
})();
