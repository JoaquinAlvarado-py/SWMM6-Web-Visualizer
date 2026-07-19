// ui.js — Toolbar, panels, properties forms, status bar,
// map style pills, OSM search, save/load, street view wiring.

(function () {
    'use strict';

    const map = window.map;
    const App = window.App;

    // Tool buttons
    document.querySelectorAll('#tool-buttons .tool-btn').forEach(btn => {
        btn.addEventListener('click', () => Tools.setTool(btn.dataset.tool));
    });

    // Undo / redo
    document.getElementById('btn-undo').addEventListener('click', () => { Net.undo(); Tools.clearSelection(); });
    document.getElementById('btn-redo').addEventListener('click', () => { Net.redo(); Tools.clearSelection(); });

    // Save / Load / Export / Clear
    document.getElementById('btn-save').addEventListener('click', () => Net.downloadProject());

    const loadDropdown = document.querySelector('.tb-dropdown');
    document.getElementById('btn-load').addEventListener('click', (e) => {
        e.stopPropagation();
        loadDropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => loadDropdown.classList.remove('open'));

    const projectInput = document.getElementById('project-file-input');
    document.getElementById('btn-load-file').addEventListener('click', () => projectInput.click());
    projectInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        projectInput.value = '';
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (data.type === 'FeatureCollection') {
                // plain GeoJSON → import as network / master plan
                if (!window.Importers.looksLikeLngLat(data)) {
                    window.openProjectionModalForGeoJSON(data, file.name);
                } else {
                    window.Importers.openImportAsModal(data, file.name);
                }
                return;
            }
            Net.loadState(data, true);
            window.clearResults();
            Tools.clearSelection();
            setTimeout(() => window.fitToNetwork(), 100);
        } catch (err) {
            alert('Could not load project file: ' + err.message);
        }
    });

    document.getElementById('btn-load-local').addEventListener('click', () => {
        if (Net.loadFromLocalStorage()) {
            window.clearResults();
            Tools.clearSelection();
            setTimeout(() => window.fitToNetwork(), 100);
        } else {
            alert('No saved project found in browser storage.');
        }
    });

    const inpInput = document.getElementById('inp-file-input');
    document.getElementById('btn-load-inp').addEventListener('click', () => inpInput.click());
    inpInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        inpInput.value = '';
        if (!file) return;
        try {
            window.showLoadingOverlay('Loading ' + file.name, 'Reading file…');
            const text = await file.text();
            window.updateLoadingOverlay(20, 'Parsing…');
            // parse off the main thread so the UI stays responsive on large files
            const model = await window.parseInpAsync(text);
            window.hideLoadingOverlay();
            if (!model.nodes.length) {
                alert('No nodes with coordinates found in the .inp file.');
                return;
            }
            window.openProjectionModal(model);
        } catch (err) {
            window.hideLoadingOverlay();
            alert('Failed to parse .inp file: ' + err.message);
        }
    });

    async function loadGitHubSample(filename) {
        try {
            window.showLoadingOverlay('Loading ' + filename, 'Fetching file…');
            const res = await fetch(`./sample_models/${filename}`);
            if (!res.ok) throw new Error('Failed to fetch ' + filename + ' (Status: ' + res.status + ')');
            const text = await res.text();
            window.updateLoadingOverlay(20, 'Parsing…');
            const model = await window.parseInpAsync(text);
            window.hideLoadingOverlay();
            if (!model.nodes.length) {
                alert('No nodes with coordinates found in the .inp file.');
                return;
            }
            window.openProjectionModal(model);
        } catch (err) {
            window.hideLoadingOverlay();
            alert('Failed to load sample: ' + err.message);
        }
    }

    document.getElementById('btn-sample-web').addEventListener('click', () => loadGitHubSample('BellingeSWMM_v021_web.inp'));
    document.getElementById('btn-sample-self').addEventListener('click', () => loadGitHubSample('BellingeSWMM_v021_selfcontained.inp'));
    document.getElementById('btn-sample-noper').addEventListener('click', () => loadGitHubSample('BellingeSWMM_v021_nopervious.inp'));

    // Options Modal
    const optionsModal = document.getElementById('options-modal');
    document.getElementById('btn-options').addEventListener('click', () => {
        const opt = Net.options || {};
        document.getElementById('opt-node-continuity').value = opt.nodeContinuity || '';
        document.getElementById('opt-anderson-accel').value = opt.andersonAccel || '';
        document.getElementById('opt-rdii-k0').value = opt.rdiiDecay ? opt.rdiiDecay.k0 : '';
        document.getElementById('opt-rdii-kt').value = opt.rdiiDecay ? opt.rdiiDecay.kT : '';
        document.getElementById('opt-rdii-tref').value = opt.rdiiDecay ? opt.rdiiDecay.tRef : '';
        optionsModal.classList.remove('hidden');
    });
    document.getElementById('btn-cancel-options').addEventListener('click', () => {
        optionsModal.classList.add('hidden');
    });
    document.getElementById('btn-save-options').addEventListener('click', () => {
        if (!Net.options) Net.options = {};
        
        const nodeCont = document.getElementById('opt-node-continuity').value;
        const anderson = document.getElementById('opt-anderson-accel').value;
        const k0 = document.getElementById('opt-rdii-k0').value;
        const kT = document.getElementById('opt-rdii-kt').value;
        const tRef = document.getElementById('opt-rdii-tref').value;
        
        if (nodeCont) Net.options.nodeContinuity = nodeCont;
        else delete Net.options.nodeContinuity;
        
        if (anderson) Net.options.andersonAccel = anderson;
        else delete Net.options.andersonAccel;
        
        if (k0 !== '' && kT !== '' && tRef !== '') {
            Net.options.rdiiDecay = { k0, kT, tRef };
        } else {
            delete Net.options.rdiiDecay;
        }
        
        optionsModal.classList.add('hidden');
    });

    document.getElementById('btn-export-inp').addEventListener('click', () => {
        if (Net.nodeCount === 0) { alert('Nothing to export — the network is empty.'); return; }
        window.inpExporter.downloadInp(Net);
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
        if (Net.nodeCount === 0 && Net.linkCount === 0 && !Net.subcatchments.length) return;
        if (!confirm('Clear the whole network? This can be undone with Ctrl+Z.')) return;
        Tools.clearSelection(false);
        window.clearResults();
        Net.reset(false);
        Net.commit();
        Net.emit();
        Tools.notifySelection();
    });

    document.getElementById('btn-run').addEventListener('click', () => window.runSimulation());

    // Units
    const unitsSelect = document.getElementById('units-select');
    unitsSelect.addEventListener('change', () => {
        Net.setUnits(unitsSelect.value);
        renderPropsPanel();
    });

    // Tabbed right panel (collapse / reopen / tab switching)
    const panelRight = document.getElementById('panel-right');
    const reopenRight = document.getElementById('reopen-right');
    const panelResizer = document.getElementById('panel-resizer');

    let isResizingRightPanel = false;

    if (panelResizer) {
        const savedPanelW = parseInt(localStorage.getItem('panel-w'), 10);
        if (savedPanelW) {
            const w = Math.max(200, Math.min(window.innerWidth - 60, savedPanelW));
            document.documentElement.style.setProperty('--panel-w', w + 'px');
        }

        panelResizer.addEventListener('mousedown', (e) => {
            isResizingRightPanel = true;
            panelResizer.classList.add('dragging');
            document.body.style.cursor = 'ew-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizingRightPanel) return;
            const newWidth = Math.max(200, Math.min(window.innerWidth - 60, window.innerWidth - e.clientX));
            document.documentElement.style.setProperty('--panel-w', newWidth + 'px');
            if (map) map.resize();
        });

        document.addEventListener('mouseup', () => {
            if (isResizingRightPanel) {
                isResizingRightPanel = false;
                panelResizer.classList.remove('dragging');
                document.body.style.cursor = '';
                localStorage.setItem('panel-w', parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-w'), 10));
                if (map) map.resize();
            }
        });
    }

    // Tab switching
    document.querySelectorAll('.panel-tab[data-tab]').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.panel-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            const target = document.getElementById('tab-' + tab.dataset.tab);
            if (target) target.classList.add('active');
        });
    });

    function setRightPanel(visible) {
        panelRight.classList.toggle('collapsed', !visible);
        reopenRight.classList.toggle('hidden', visible);
        document.getElementById('app-grid').classList.toggle('panel-collapsed', !visible);
        setTimeout(() => map.resize(), 50);
    }

    document.getElementById('btn-collapse-right').addEventListener('click', () => setRightPanel(false));
    reopenRight.addEventListener('click', () => setRightPanel(true));

    // Left palette toggle
    const palette = document.getElementById('tool-palette');
    const reopenLeft = document.getElementById('btn-reopen-palette');
    const btnCollapseLeft = document.getElementById('btn-collapse-palette');

    function setLeftPalette(visible) {
        if (visible) {
            palette.classList.remove('collapsed');
            reopenLeft.classList.add('hidden');
        } else {
            palette.classList.add('collapsed');
            reopenLeft.classList.remove('hidden');
        }
        setTimeout(() => map.resize(), 50);
    }
    btnCollapseLeft.addEventListener('click', () => setLeftPalette(false));
    reopenLeft.addEventListener('click', () => setLeftPalette(true));

    window.openResultsPanel = () => {
        setRightPanel(true);
        // Switch to results tab
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel-tab-content').forEach(c => c.classList.remove('active'));
        const resultsTab = document.querySelector('.panel-tab[data-tab="results"]');
        const resultsContent = document.getElementById('tab-results');
        if (resultsTab) resultsTab.classList.add('active');
        if (resultsContent) resultsContent.classList.add('active');
        // Show badge
        const badge = document.getElementById('results-badge');
        if (badge) badge.classList.remove('hidden');
    };

    // Map settings card toggle
    const btnToggleSettings = document.getElementById('btn-toggle-map-settings');
    const mapSettingsCard = document.getElementById('map-settings-card');
    btnToggleSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        const hidden = mapSettingsCard.classList.toggle('hidden');
        btnToggleSettings.classList.toggle('active', !hidden);
    });
    // Close settings card when clicking outside on the map (but not inside the card itself)
    document.addEventListener('click', (e) => {
        if (!mapSettingsCard.contains(e.target) && e.target !== btnToggleSettings && !btnToggleSettings.contains(e.target)) {
            mapSettingsCard.classList.add('hidden');
            btnToggleSettings.classList.remove('active');
        }
    });

    // Map style pills / labels / 3D
    document.querySelectorAll('#map-style-pills .tb-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('#map-style-pills .tb-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            window.setMapStyle(pill.dataset.style);
        });
    });

    const btnLabels = document.getElementById('btn-toggle-labels');
    btnLabels.addEventListener('click', () => {
        App.labelsVisible = !App.labelsVisible;
        btnLabels.classList.toggle('toggled', App.labelsVisible);
        window.applyLabelsVisibility();
    });

    const btn3D = document.getElementById('btn-toggle-3d');
    btn3D.addEventListener('click', () => {
        App.is3D = !App.is3D;
        btn3D.classList.toggle('toggled', App.is3D);
        window.apply3D();
    });

    // OSM place search (Nominatim)
    const searchInput = document.getElementById('osm-search-input');
    const searchResults = document.getElementById('osm-search-results');

    async function doSearch() {
        const q = searchInput.value.trim();
        if (!q) return;
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`,
                { headers: { 'Accept-Language': 'en' } });
            const results = await res.json();
            searchResults.innerHTML = '';
            if (!results.length) {
                searchResults.innerHTML = '<button class="osm-result" disabled>No results found</button>';
            } else {
                results.forEach(r => {
                    const btn = document.createElement('button');
                    btn.className = 'osm-result';
                    btn.textContent = r.display_name;
                    btn.addEventListener('click', () => {
                        searchResults.classList.add('hidden');
                        searchInput.value = r.display_name.split(',')[0];
                        if (r.boundingbox) {
                            const [s, n, w, e] = r.boundingbox.map(Number);
                            map.fitBounds([[w, s], [e, n]], { duration: 1500, maxZoom: 17 });
                        } else {
                            map.flyTo({ center: [Number(r.lon), Number(r.lat)], zoom: 15 });
                        }
                    });
                    searchResults.appendChild(btn);
                });
            }
            searchResults.classList.remove('hidden');
        } catch (err) {
            console.warn('Nominatim search failed', err);
        }
    }

    document.getElementById('osm-search-btn').addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
        if (e.key === 'Escape') searchResults.classList.add('hidden');
    });
    document.addEventListener('click', (e) => {
        if (!document.getElementById('osm-search').contains(e.target)) searchResults.classList.add('hidden');
    });

    // Street View pegman
    const btnPegman = document.getElementById('btn-pegman');
    const svWrapper = document.getElementById('street-view-wrapper');
    let svActive = false;

    btnPegman.addEventListener('click', () => {
        svActive = !svActive;
        btnPegman.classList.toggle('active', svActive);
        svWrapper.classList.toggle('hidden', !svActive);
        if (svActive) {
            if (window.StreetViewOverlay) window.StreetViewOverlay.init();
        } else {
            if (window.StreetViewOverlay) window.StreetViewOverlay.destroy();
        }
        setTimeout(() => map.resize(), 50);
    });

    document.getElementById('btn-close-sv').addEventListener('click', () => {
        svActive = false;
        btnPegman.classList.remove('active');
        svWrapper.classList.add('hidden');
        if (window.StreetViewOverlay) window.StreetViewOverlay.destroy();
        setTimeout(() => map.resize(), 50);
    });

    // Street view resizing
    const svResizeHandle = document.getElementById('sv-resize-handle');
    let isResizingSV = false;
    
    if (svResizeHandle) {
        svResizeHandle.addEventListener('mousedown', (e) => {
            isResizingSV = true;
            document.body.style.cursor = 'ns-resize';
            const svContainer = document.getElementById('street-view-container');
            if (svContainer) svContainer.style.pointerEvents = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizingSV) return;
            // Calculate height as percentage of window height
            let newHeightPct = (e.clientY / window.innerHeight) * 100;
            // Clamp between 20% and 80%
            newHeightPct = Math.max(20, Math.min(80, newHeightPct));
            document.documentElement.style.setProperty('--sv-height', newHeightPct + '%');
            if (map) map.resize();
            if (window.StreetViewOverlay) window.StreetViewOverlay.resize();
        });

        document.addEventListener('mouseup', () => {
            if (isResizingSV) {
                isResizingSV = false;
                document.body.style.cursor = '';
                const svContainer = document.getElementById('street-view-container');
                if (svContainer) svContainer.style.pointerEvents = 'auto';
                if (map) map.resize();
                if (window.StreetViewOverlay) window.StreetViewOverlay.resize();
            }
        });
    }

    // Properties panel
    const propsBody = document.getElementById('props-body');

    const U = (si, us) => Net.units === 'US' ? us : si;

    const FIELD_DEFS = {
        JUNCTION: () => [
            { key: 'invertEl', label: 'Invert elevation', unit: U('m', 'ft'), type: 'number' },
            { key: 'maxDepth', label: 'Max depth', unit: U('m', 'ft'), type: 'number' },
            { key: 'initDepth', label: 'Init depth', unit: U('m', 'ft'), type: 'number' },
            { key: 'surDepth', label: 'Surcharge depth', unit: U('m', 'ft'), type: 'number' },
            { key: 'aponded', label: 'Ponded area', unit: U('m²', 'ft²'), type: 'number' }
        ],
        OUTFALL: () => [
            { key: 'invertEl', label: 'Invert elevation', unit: U('m', 'ft'), type: 'number' },
            { key: 'outfallType', label: 'Type', type: 'select', options: ['FREE', 'NORMAL', 'FIXED'] },
            { key: 'stageData', label: 'Fixed stage', unit: U('m', 'ft'), type: 'text' },
            { key: 'gated', label: 'Flap gate', type: 'select', options: ['NO', 'YES'] }
        ],
        STORAGE: () => [
            { key: 'invertEl', label: 'Invert elevation', unit: U('m', 'ft'), type: 'number' },
            { key: 'maxDepth', label: 'Max depth', unit: U('m', 'ft'), type: 'number' },
            { key: 'initDepth', label: 'Init depth', unit: U('m', 'ft'), type: 'number' },
            { key: 'shape', label: 'Shape curve', type: 'select', options: ['FUNCTIONAL', 'TABULAR'] },
            { key: 'curveName', label: 'Storage curve (tabular)', type: 'text' },
            { key: 'coeff', label: 'Coefficient', type: 'number' },
            { key: 'exponent', label: 'Exponent', type: 'number' },
            { key: 'constant', label: 'Constant', type: 'number' }
        ],
        DIVIDER: () => [
            { key: 'invertEl', label: 'Invert elevation', unit: U('m', 'ft'), type: 'number' },
            { key: 'divertedLink', label: 'Diverted link', type: 'text' },
            { key: 'dividerType', label: 'Type', type: 'select', options: ['CUTOFF', 'OVERFLOW', 'TABULAR', 'WEIR'] },
            { key: 'param', label: 'Parameter', type: 'number' },
            { key: 'maxDepth', label: 'Max depth', unit: U('m', 'ft'), type: 'number' }
        ],
        RAINGAGE: () => [
            { key: 'format', label: 'Rain format', type: 'select', options: ['INTENSITY', 'VOLUME', 'CUMULATIVE'] },
            { key: 'interval', label: 'Interval', unit: 'h:mm', type: 'text' },
            { key: 'scf', label: 'Snow catch factor', type: 'number' },
            { key: 'sourceType', label: 'Source', type: 'select', options: ['TIMESERIES', 'FILE'] },
            { key: 'sourceName', label: 'Series / file name', type: 'text' }
        ],
        CONDUIT: () => [
            { key: 'length', label: 'Length', unit: U('m', 'ft'), type: 'number' },
            { key: 'autoLength', label: 'Auto length', type: 'select', options: ['true', 'false'], bool: true },
            { key: 'roughness', label: 'Roughness (n)', type: 'number', step: 0.001 },
            { key: 'inOffset', label: 'Inlet offset', unit: U('m', 'ft'), type: 'number' },
            { key: 'outOffset', label: 'Outlet offset', unit: U('m', 'ft'), type: 'number' },
            { key: 'xShape', label: 'X-section', type: 'select', options: ['CIRCULAR', 'FORCE_MAIN', 'FILLED_CIRCULAR', 'RECT_CLOSED', 'RECT_OPEN', 'TRAPEZOIDAL', 'TRIANGULAR', 'EGG', 'HORSESHOE', 'PARABOLIC'] },
            { key: 'geom1', label: 'Geom1 (depth/diam)', unit: U('m', 'ft'), type: 'number', step: 0.05 },
            { key: 'geom2', label: 'Geom2 (width)', unit: U('m', 'ft'), type: 'number', step: 0.05 },
            { key: 'geom3', label: 'Geom3', type: 'number', step: 0.05 },
            { key: 'geom4', label: 'Geom4', type: 'number', step: 0.05 },
            { key: 'barrels', label: 'Barrels', type: 'number', step: 1 }
        ],
        PUMP: () => [
            { key: 'pumpCurve', label: 'Pump curve', type: 'text' },
            { key: 'status', label: 'Initial status', type: 'select', options: ['ON', 'OFF'] },
            { key: 'startup', label: 'Startup depth', unit: U('m', 'ft'), type: 'number' },
            { key: 'shutoff', label: 'Shutoff depth', unit: U('m', 'ft'), type: 'number' }
        ],
        WEIR: () => [
            { key: 'weirType', label: 'Type', type: 'select', options: ['TRANSVERSE', 'SIDEFLOW', 'V-NOTCH', 'TRAPEZOIDAL'] },
            { key: 'crestHt', label: 'Crest height', unit: U('m', 'ft'), type: 'number' },
            { key: 'qCoeff', label: 'Discharge coeff.', type: 'number', step: 0.01 },
            { key: 'gated', label: 'Flap gate', type: 'select', options: ['NO', 'YES'] },
            { key: 'geom1', label: 'Height', unit: U('m', 'ft'), type: 'number', step: 0.05 },
            { key: 'geom2', label: 'Width', unit: U('m', 'ft'), type: 'number', step: 0.05 }
        ],
        ORIFICE: () => [
            { key: 'orificeType', label: 'Type', type: 'select', options: ['SIDE', 'BOTTOM'] },
            { key: 'offset', label: 'Inlet offset', unit: U('m', 'ft'), type: 'number' },
            { key: 'qCoeff', label: 'Discharge coeff.', type: 'number', step: 0.01 },
            { key: 'gated', label: 'Flap gate', type: 'select', options: ['NO', 'YES'] },
            { key: 'xShape', label: 'Shape', type: 'select', options: ['CIRCULAR', 'RECT_CLOSED'] },
            { key: 'geom1', label: 'Height/diameter', unit: U('m', 'ft'), type: 'number', step: 0.05 },
            { key: 'geom2', label: 'Width', unit: U('m', 'ft'), type: 'number', step: 0.05 }
        ],
        OUTLET: () => [
            { key: 'outletType', label: 'Rating type', type: 'select', options: ['FUNCTIONAL/DEPTH', 'FUNCTIONAL/HEAD', 'TABULAR/DEPTH', 'TABULAR/HEAD'] },
            { key: 'offset', label: 'Inlet offset', unit: U('m', 'ft'), type: 'number' },
            { key: 'qCoeff', label: 'Flow coeff. (functional)', type: 'number', step: 0.01 },
            { key: 'qExpon', label: 'Flow exponent (functional)', type: 'number', step: 0.01 },
            { key: 'curveName', label: 'Rating curve (tabular)', type: 'text' },
            { key: 'gated', label: 'Flap gate', type: 'select', options: ['NO', 'YES'] }
        ],
        SUBCATCHMENT: () => [
            { key: 'raingage', label: 'Rain gage', type: 'text' },
            { key: 'outlet', label: 'Outlet node', type: 'text' },
            { key: 'area', label: 'Area', unit: U('ha', 'ac'), type: 'number', step: 0.01 },
            { key: 'imperv', label: 'Impervious', unit: '%', type: 'number' },
            { key: 'width', label: 'Width', unit: U('m', 'ft'), type: 'number' },
            { key: 'slope', label: 'Slope', unit: '%', type: 'number', step: 0.1 },
            { key: 'curbLen', label: 'Curb length', type: 'number' }
        ]
    };

    const TYPE_LABELS = {
        JUNCTION: 'Junction', OUTFALL: 'Outfall', STORAGE: 'Storage Unit', DIVIDER: 'Flow Divider',
        RAINGAGE: 'Rain Gage', CONDUIT: 'Conduit', PUMP: 'Pump', WEIR: 'Weir', ORIFICE: 'Orifice',
        OUTLET: 'Outlet',
        SUBCATCHMENT: 'Subcatchment'
    };

    function esc(s) {
        return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    window.renderPropsPanel = function renderPropsPanel() {
        updateProfileButton();
        const sel = [...App.selection];

        if (!sel.length) {
            propsBody.innerHTML = '<p class="panel-empty">Select an element on the map to see its properties.</p>';
            return;
        }

        // Auto-switch to Properties tab when something is selected
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel-tab-content').forEach(c => c.classList.remove('active'));
        const propsTab = document.querySelector('.panel-tab[data-tab="props"]');
        const propsContent = document.getElementById('tab-props');
        if (propsTab) propsTab.classList.add('active');
        if (propsContent) propsContent.classList.add('active');

        if (sel.length > 1) {
            propsBody.innerHTML = `
                <p class="panel-empty">${sel.length} elements selected.</p>
                <div class="prop-actions">
                    <button class="tb-btn prop-btn-danger" id="prop-delete-multi">Delete selected</button>
                </div>`;
            document.getElementById('prop-delete-multi').addEventListener('click', () => Tools.deleteSelection());
            return;
        }

        const id = sel[0];
        const el = Net.findAny(id);
        if (!el) {
            propsBody.innerHTML = '<p class="panel-empty">Select an element on the map to see its properties.</p>';
            return;
        }

        const type = el.type || 'SUBCATCHMENT';
        const defs = (FIELD_DEFS[type] || (() => []))();

        let html = `<div class="prop-section-title">${esc(TYPE_LABELS[type] || type)}</div>`;
        html += `<div class="prop-row"><label>Name</label><input type="text" id="prop-id" value="${esc(el.id)}"></div>`;

        if (el.from !== undefined) {
            html += `<div class="prop-row"><label>From node</label><input type="text" value="${esc(el.from)}" readonly></div>`;
            html += `<div class="prop-row"><label>To node</label><input type="text" value="${esc(el.to)}" readonly></div>`;
        }
        if (el.lngLat) {
            html += `<div class="prop-row"><label>Position <span class="unit-hint">(lat, lng)</span></label>
                <input type="text" value="${el.lngLat[1].toFixed(6)}, ${el.lngLat[0].toFixed(6)}" readonly></div>`;
        }

        defs.forEach(f => {
            const val = el.props[f.key];
            const unitHint = f.unit ? ` <span class="unit-hint">(${esc(f.unit)})</span>` : '';
            if (f.type === 'select') {
                const opts = f.options.map(o =>
                    `<option value="${esc(o)}" ${String(val) === o ? 'selected' : ''}>${esc(o)}</option>`).join('');
                html += `<div class="prop-row"><label>${esc(f.label)}${unitHint}</label>
                    <select data-key="${f.key}" data-bool="${f.bool ? '1' : ''}">${opts}</select></div>`;
            } else {
                const step = f.step ? ` step="${f.step}"` : (f.type === 'number' ? ' step="any"' : '');
                html += `<div class="prop-row"><label>${esc(f.label)}${unitHint}</label>
                    <input type="${f.type}"${step} data-key="${f.key}" value="${esc(val)}"></div>`;
            }
        });

        html += `<div class="prop-actions">
            <button class="tb-btn prop-btn-danger" id="prop-delete">Delete</button>
        </div>`;

        propsBody.innerHTML = html;

        // wire inputs
        propsBody.querySelectorAll('[data-key]').forEach(input => {
            input.addEventListener('change', () => {
                const key = input.dataset.key;
                let value = input.value;
                if (input.dataset.bool === '1') value = value === 'true';
                else if (input.type === 'number') value = parseFloat(value) || 0;
                Net.updateProps(el.id, { [key]: value });
                // manual length edit disables auto length
                if (key === 'length' && el.type === 'CONDUIT') {
                    Net.updateProps(el.id, { autoLength: false });
                    renderPropsPanel();
                }
                if (key === 'autoLength' && value === true && el.type === 'CONDUIT') {
                    Net.updateProps(el.id, {}); // triggers recompute
                    renderPropsPanel();
                }
            });
        });

        document.getElementById('prop-id').addEventListener('change', (e) => {
            const newId = Net.renameElement(el.id, e.target.value);
            App.selection.delete(id);
            App.selection.add(newId);
            window.setElementState(newId, { selected: true });
            renderPropsPanel();
        });

        document.getElementById('prop-delete').addEventListener('click', () => Tools.deleteSelection());
    };

    // Profile plot button: show when 2+ hydraulic nodes selected and results loaded
    const HYDRAULIC_TYPES = new Set(['JUNCTION', 'OUTFALL', 'STORAGE', 'DIVIDER']);
    const btnProfile = document.getElementById('btn-profile');

    function updateProfileButton() {
        if (!btnProfile) return;
        const resultsActive = window.ResultStyling && window.ResultStyling.active;
        if (!resultsActive) { btnProfile.classList.add('hidden'); return; }

        const hydroNodes = [...App.selection]
            .map(id => Net.getNode(id))
            .filter(n => n && HYDRAULIC_TYPES.has(n.type));

        if (hydroNodes.length >= 2) {
            btnProfile.classList.remove('hidden');
        } else {
            btnProfile.classList.add('hidden');
        }
    }

    if (btnProfile) {
        btnProfile.addEventListener('click', () => {
            // Collect ordered hydraulic node IDs from current selection
            const hydroIds = [...App.selection]
                .map(id => Net.getNode(id))
                .filter(n => n && HYDRAULIC_TYPES.has(n.type))
                .map(n => n.id);

            if (window.ProfilePlot) window.ProfilePlot.openForNodes(hydroIds);
        });
    }

    // Status bar + counters + undo/redo button states
    window.updateUICounts = function () {
        document.getElementById('sb-nodes').textContent = Net.nodeCount;
        document.getElementById('sb-links').textContent = Net.linkCount;
        document.getElementById('stat-nodes').textContent = Net.nodeCount;
        document.getElementById('stat-links').textContent = Net.linkCount;
        document.getElementById('stat-subcatchments').textContent = Net.subcatchments.length;
        document.getElementById('btn-undo').disabled = !Net.canUndo;
        document.getElementById('btn-redo').disabled = !Net.canRedo;

        // drop selection entries that no longer exist (e.g. after undo)
        let changed = false;
        [...App.selection].forEach(id => {
            if (!Net.findAny(id)) { App.selection.delete(id); changed = true; }
        });
        if (changed) renderPropsPanel();
    };

    // Animation UI
    const timeSliderPanel = document.getElementById('time-slider-panel');
    const timeSlider = document.getElementById('time-slider');
    const timeDisplay = document.getElementById('time-display');
    const btnPlayPause = document.getElementById('btn-play-pause');
    const btnSpeed = document.getElementById('btn-speed');

    let animationRaf = null;
    let isPlaying = false;
    let speedIdx = 0;
    const speeds = [1, 2, 4, 8, 16];

    window.AnimationUI = {
        show() {
            timeSliderPanel.classList.remove('hidden');
        },
        hide() {
            timeSliderPanel.classList.add('hidden');
            this.pause();
        },
        setRange(maxSteps) {
            timeSlider.min = 0;
            timeSlider.max = Math.max(0, maxSteps - 1);
            timeSlider.value = 0;
            this.updateDisplay();
        },
        updateDisplay() {
            const step = parseInt(timeSlider.value);
            // We'll update time display based on results data later
            timeDisplay.textContent = `Step: ${step}`;
            if (window.ResultStyling && typeof window.ResultStyling.applyToMapForStep === 'function') {
                window.ResultStyling.applyToMapForStep(step);
            }
            if (window.Tools && typeof window.Tools.updateHoverPopup === 'function') {
                window.Tools.updateHoverPopup(step);
            }
            // Sync profile plot to current time step
            if (window.ProfilePlot && typeof window.ProfilePlot.update === 'function') {
                window.ProfilePlot.update(step);
            }
            // Sync Street View overlay animation
            if (window.StreetViewOverlay && typeof window.StreetViewOverlay.scheduleRedraw === 'function') {
                window.StreetViewOverlay.scheduleRedraw();
            }
        },
        play() {
            if (isPlaying) return;
            isPlaying = true;
            btnPlayPause.textContent = '⏸ Pause';

            // rAF-driven loop: steps advance on the animation clock instead of
            // setInterval, so updates stay in sync with actual rendered frames
            // (no wasted setFeatureState calls between frames at high speeds).
            let lastTime = performance.now();
            const tick = (now) => {
                if (!isPlaying) return;
                const stepDuration = 500 / speeds[speedIdx];
                if (now - lastTime >= stepDuration) {
                    // Advance by however many steps elapsed, render once
                    const advance = Math.max(1, Math.floor((now - lastTime) / stepDuration));
                    lastTime = now;
                    let step = parseInt(timeSlider.value);
                    const max = parseInt(timeSlider.max);
                    step += advance;
                    if (step > max) step = 0;
                    timeSlider.value = step;
                    this.updateDisplay();
                }
                animationRaf = requestAnimationFrame(tick);
            };
            animationRaf = requestAnimationFrame(tick);
        },
        pause() {
            if (!isPlaying) return;
            isPlaying = false;
            btnPlayPause.textContent = '▶ Play';
            if (animationRaf) { cancelAnimationFrame(animationRaf); animationRaf = null; }
        }
    };

    btnPlayPause.addEventListener('click', () => {
        if (isPlaying) window.AnimationUI.pause();
        else window.AnimationUI.play();
    });

    btnSpeed.addEventListener('click', () => {
        speedIdx = (speedIdx + 1) % speeds.length;
        btnSpeed.textContent = speeds[speedIdx] + 'x';
        if (isPlaying) {
            window.AnimationUI.pause();
            window.AnimationUI.play();
        }
    });

    timeSlider.addEventListener('input', () => {
        if (isPlaying) window.AnimationUI.pause();
        window.AnimationUI.updateDisplay();
    });


    // Startup: restore autosaved project
    map.on('load', () => {
        if (Net.loadFromLocalStorage()) {
            unitsSelect.value = Net.units;
            setTimeout(() => window.fitToNetwork(), 300);
        }
        window.updateUICounts();
    });

    // initialize defaults
    Tools.setTool('select');
    window.updateUICounts();
})();
