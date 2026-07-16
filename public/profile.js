// profile.js — 2D Water Elevation Profile Plot
// Replicates SWMM 5.2's longitudinal profile window.
// Exposes window.ProfilePlot

(function () {
    'use strict';

    // State
    let currentPath = null;  // { nodeIds: [], edges: [] }
    let modalEl     = null;
    let canvasEl    = null;
    let ctx         = null;
    let currentStep = 0;

    const PAD = { top: 40, right: 24, bottom: 52, left: 68 };

    // 1. HAVERSINE (inline — no dependency on Net internals)
    function haversineDist(a, b) {
        const R = 6371008.8;
        const dLat = (b[1] - a[1]) * Math.PI / 180;
        const dLng = (b[0] - a[0]) * Math.PI / 180;
        const la1  = a[1] * Math.PI / 180;
        const la2  = b[1] * Math.PI / 180;
        const h    = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    function conduitLength(lnk, fromNode, toNode) {
        const p = lnk.props;
        if (!p.autoLength && p.length && p.length > 0) return p.length;
        const coords = [fromNode.lngLat, ...(lnk.vertices || []), toNode.lngLat];
        let d = 0;
        for (let i = 1; i < coords.length; i++) d += haversineDist(coords[i - 1], coords[i]);
        return d;
    }

    // 2. PATH TRACING (BFS through conduits only)
    // Returns { nodeIds: [], edges: [{from, to, conduit, reversed}] }
    // or null if no path found.
    function tracePath(nodeIds) {
        if (nodeIds.length < 2) return null;

        const start = nodeIds[0];
        const end   = nodeIds[nodeIds.length - 1];

        // Build adjacency for conduits only
        const adj = {};
        Net.nodes.forEach(n => { adj[n.id] = []; });
        Net.links.forEach(lnk => {
            if (lnk.type !== 'CONDUIT') return;
            if (adj[lnk.from] !== undefined)
                adj[lnk.from].push({ conduit: lnk, neighbor: lnk.to,  reversed: false });
            if (adj[lnk.to] !== undefined)
                adj[lnk.to].push({ conduit: lnk,  neighbor: lnk.from, reversed: true });
        });

        // BFS
        const visited = new Set([start]);
        const queue   = [[start, []]];

        while (queue.length) {
            const [cur, path] = queue.shift();
            if (cur === end) {
                const orderedNodes = [start, ...path.map(e => e.to)];
                return { nodeIds: orderedNodes, edges: path };
            }
            for (const edge of (adj[cur] || [])) {
                if (!visited.has(edge.neighbor)) {
                    visited.add(edge.neighbor);
                    queue.push([
                        edge.neighbor,
                        [...path, { from: cur, to: edge.neighbor, conduit: edge.conduit, reversed: edge.reversed }]
                    ]);
                }
            }
        }
        return null;
    }

    // 3. GEOMETRY BUILD
    function buildGeometry(step) {
        const ts = window.ResultStyling && window.ResultStyling.timeSeries;
        const segments = [];
        let cumDist = 0;

        for (const edge of currentPath.edges) {
            const lnk      = edge.conduit;
            const fromNode  = Net.getNode(edge.from);
            const toNode    = Net.getNode(edge.to);
            if (!fromNode || !toNode) continue;

            const len = conduitLength(lnk, fromNode, toNode);
            const p   = lnk.props;

            const fromInv = fromNode.props.invertEl || 0;
            const toInv   = toNode.props.invertEl   || 0;

            // Offsets: inOffset is at the conduit's "from" end, outOffset at "to" end.
            // If the edge is reversed in the profile, upInv uses fromInv (which is the conduit's original toNode) + outOffset.
            const upInv = edge.reversed
                ? fromInv + (p.outOffset || 0)
                : fromInv + (p.inOffset  || 0);
            const dnInv = edge.reversed
                ? toInv   + (p.inOffset  || 0)
                : toInv   + (p.outOffset || 0);

            const diam    = p.geom1 || 1.0;
            const upCrown = upInv + diam;
            const dnCrown = dnInv + diam;

            // Ground elevation = invert + maxDepth at junction
            const upGround = fromInv + (fromNode.props.maxDepth || diam * 2);
            const dnGround = toInv   + (toNode.props.maxDepth   || diam * 2);

            // Hydraulic head (water surface elevation) from time series
            let upHead = upInv;
            let dnHead = dnInv;
            if (ts) {
                const ndFrom = ts.nodes[edge.from];
                const ndTo   = ts.nodes[edge.to];
                if (ndFrom) {
                    upHead = (ndFrom.head && ndFrom.head[step] !== undefined)
                        ? ndFrom.head[step]
                        : fromInv + (ndFrom.depth && ndFrom.depth[step] !== undefined ? ndFrom.depth[step] : 0);
                }
                if (ndTo) {
                    dnHead = (ndTo.head && ndTo.head[step] !== undefined)
                        ? ndTo.head[step]
                        : toInv + (ndTo.depth && ndTo.depth[step] !== undefined ? ndTo.depth[step] : 0);
                }
            }

            // Link capacity for fill color tinting
            let cap = 0;
            if (ts && ts.links[lnk.id]) {
                const ld = ts.links[lnk.id];
                cap = (ld.capacity && ld.capacity[step] !== undefined) ? ld.capacity[step] : 0;
            }

            segments.push({
                fromId: edge.from, toId: edge.to, linkId: lnk.id,
                xStart: cumDist,   xEnd: cumDist + len,
                upInv, dnInv, upCrown, dnCrown,
                upGround, dnGround,
                upHead, dnHead,
                diam, length: len, cap
            });

            cumDist += len;
        }

        // Node X positions
        const nodeX = {};
        nodeX[currentPath.nodeIds[0]] = 0;
        for (const s of segments) nodeX[s.toId] = s.xEnd;

        return { segments, totalDist: cumDist, nodeX };
    }

    // 4. DRAW
    function draw(step) {
        if (!ctx || !currentPath || !canvasEl) return;
        currentStep = step;

        const geo = buildGeometry(step);
        if (!geo.segments.length) return;

        const W     = canvasEl.width;
        const H     = canvasEl.height;
        const plotW = W - PAD.left - PAD.right;
        const plotH = H - PAD.top  - PAD.bottom;

        if (plotW <= 0 || plotH <= 0) return;

        // Elevation bounds
        let minEl = Infinity, maxEl = -Infinity;
        for (const s of geo.segments) {
            minEl = Math.min(minEl, s.upInv,   s.dnInv,   s.upHead,   s.dnHead);
            maxEl = Math.max(maxEl, s.upCrown,  s.dnCrown,  s.upGround, s.dnGround, s.upHead, s.dnHead);
        }
        if (!isFinite(minEl)) { minEl = 0; maxEl = 10; }
        const pad   = Math.max((maxEl - minEl) * 0.12, 0.5);
        minEl -= pad * 0.3;
        maxEl += pad;
        const elevRange = maxEl - minEl;

        // Coordinate helpers
        const marginX = 30; // padding inside the plot to prevent node clipping
        const innerPlotW = Math.max(1, plotW - marginX * 2);
        const cx = x  => PAD.left + marginX + (x  / (geo.totalDist || 1)) * innerPlotW;
        const cy = el => PAD.top  + plotH - ((el - minEl) / elevRange) * plotH;

        // Clear
        ctx.clearRect(0, 0, W, H);

        // Plot background
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(PAD.left, PAD.top, plotW, plotH);

        // Horizontal grid (elevation ticks)
        const isUS = (typeof Net !== 'undefined') && Net.units === 'US';
        const nGridH = Math.min(8, Math.ceil(plotH / 40));
        const rawStep = elevRange / nGridH;
        const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
        const niceMults = [1, 2, 2.5, 5, 10];
        let gridStepEl = mag;
        for (const m of niceMults) {
            if (mag * m >= rawStep) { gridStepEl = mag * m; break; }
        }
        const firstGridEl = Math.ceil(minEl / gridStepEl) * gridStepEl;

        ctx.font = '11px Inter, system-ui, sans-serif';
        for (let el = firstGridEl; el <= maxEl + gridStepEl * 0.01; el += gridStepEl) {
            const y = cy(el);
            if (y < PAD.top - 2 || y > PAD.top + plotH + 2) continue;
            ctx.strokeStyle = '#e2e8f0';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(PAD.left, y);
            ctx.lineTo(PAD.left + plotW, y);
            ctx.stroke();

            ctx.fillStyle = '#64748b';
            ctx.textAlign = 'right';
            ctx.fillText(el.toFixed(1), PAD.left - 6, y + 4);
        }

        // Vertical grid (distance)
        const nGridV = Math.max(4, Math.min(12, Math.ceil(plotW / 80)));
        const vStepDist = geo.totalDist / nGridV;
        const niceDStep  = Math.pow(10, Math.round(Math.log10(vStepDist)));
        let niceVStep = niceDStep;
        for (const m of [1, 2, 5, 10]) {
            if (niceDStep * m >= vStepDist) { niceVStep = niceDStep * m; break; }
        }
        const firstVD = 0;

        ctx.font = '11px Inter, system-ui, sans-serif';
        for (let d = firstVD; d <= geo.totalDist + niceVStep * 0.01; d += niceVStep) {
            if (d > geo.totalDist * 1.01) break;
            const x = cx(d);
            ctx.strokeStyle = '#e2e8f0';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, PAD.top);
            ctx.lineTo(x, PAD.top + plotH);
            ctx.stroke();

            ctx.fillStyle = '#64748b';
            ctx.textAlign = 'center';
            ctx.fillText(Math.round(d), x, PAD.top + plotH + 16);
        }

        // Clip to plot area
        ctx.save();
        ctx.beginPath();
        ctx.rect(PAD.left, PAD.top, plotW, plotH);
        ctx.clip();

        // Ground surface line (dashed green)
        ctx.beginPath();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#16a34a';
        ctx.lineWidth = 1.5;
        let firstSeg = true;
        for (const s of geo.segments) {
            const p1 = [cx(s.xStart), cy(s.upGround)];
            const p2 = [cx(s.xEnd),   cy(s.dnGround)];
            if (firstSeg) { ctx.moveTo(p1[0], p1[1]); firstSeg = false; }
            else ctx.lineTo(p1[0], p1[1]);
            ctx.lineTo(p2[0], p2[1]);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Dry pipe fill + boundaries
        for (const s of geo.segments) {
            const x1 = cx(s.xStart), x2 = cx(s.xEnd);
            const iUp = cy(s.upInv),  iDn = cy(s.dnInv);
            const cUp = cy(s.upCrown), cDn = cy(s.dnCrown);

            // Grey cross-section fill
            ctx.beginPath();
            ctx.moveTo(x1, cUp);
            ctx.lineTo(x2, cDn);
            ctx.lineTo(x2, iDn);
            ctx.lineTo(x1, iUp);
            ctx.closePath();
            ctx.fillStyle = 'rgba(148,163,184,0.25)';
            ctx.fill();
        }

        // Water fill
        const ts = window.ResultStyling && window.ResultStyling.timeSeries;
        if (ts) {
            for (const s of geo.segments) {
                const x1  = cx(s.xStart), x2 = cx(s.xEnd);
                const iUp = cy(s.upInv),  iDn = cy(s.dnInv);

                // Water surface clamped to pipe crown
                const wsUp = cy(Math.min(s.upHead, s.upCrown));
                const wsDn = cy(Math.min(s.dnHead, s.dnCrown));

                // Color: near-full → amber, surcharged → red, normal → cyan
                let fillColor;
                if (s.cap >= 1.0) {
                    fillColor = 'rgba(220,38,38,0.65)';      // red — surcharged
                } else if (s.cap >= 0.85) {
                    fillColor = 'rgba(245,158,11,0.70)';     // amber — near full
                } else {
                    fillColor = 'rgba(0,188,212,0.72)';      // cyan — normal
                }

                // Only draw if there's actually water
                const hasWater = (s.upHead > s.upInv + 0.0001) || (s.dnHead > s.dnInv + 0.0001);
                if (!hasWater) continue;

                ctx.beginPath();
                ctx.moveTo(x1, wsUp);
                ctx.lineTo(x2, wsDn);
                ctx.lineTo(x2, iDn);
                ctx.lineTo(x1, iUp);
                ctx.closePath();
                ctx.fillStyle = fillColor;
                ctx.fill();

                // Water surface line (blue)
                ctx.beginPath();
                ctx.moveTo(x1, wsUp);
                ctx.lineTo(x2, wsDn);
                ctx.strokeStyle = '#0284c7';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }

        // Pipe crown + invert boundary lines
        for (const s of geo.segments) {
            const x1  = cx(s.xStart), x2 = cx(s.xEnd);
            const iUp = cy(s.upInv),  iDn = cy(s.dnInv);
            const cUp = cy(s.upCrown), cDn = cy(s.dnCrown);

            ctx.lineWidth = 2;
            ctx.strokeStyle = '#334155';

            // Crown
            ctx.beginPath();
            ctx.moveTo(x1, cUp);
            ctx.lineTo(x2, cDn);
            ctx.stroke();

            // Invert
            ctx.beginPath();
            ctx.moveTo(x1, iUp);
            ctx.lineTo(x2, iDn);
            ctx.stroke();
        }

        // Node vertical bars + labels
        for (const [nid, xd] of Object.entries(geo.nodeX)) {
            const node = Net.getNode(nid);
            if (!node) continue;
            const x       = cx(xd);
            const invY    = cy(node.props.invertEl || 0);
            const gndY    = cy((node.props.invertEl || 0) + (node.props.maxDepth || 2));

            // Thin vertical line (node manhole)
            ctx.beginPath();
            ctx.strokeStyle = '#475569';
            ctx.lineWidth = 1.5;
            ctx.moveTo(x, gndY);
            ctx.lineTo(x, invY);
            ctx.stroke();

            // Node ID label above ground line
            ctx.fillStyle = '#1e293b';
            ctx.font = 'bold 11px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';

            // White halo behind label
            const lw = ctx.measureText(nid).width;
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.fillRect(x - lw / 2 - 2, gndY - 20, lw + 4, 14);
            ctx.fillStyle = '#0f172a';
            ctx.fillText(nid, x, gndY - 9);
        }

        ctx.restore(); // end clip

        // Plot border
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(PAD.left, PAD.top, plotW, plotH);

        // Axis labels
        ctx.save();
        ctx.fillStyle = '#475569';
        ctx.font = '12px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.translate(15, PAD.top + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(`Elevation (${isUS ? 'ft' : 'm'})`, 0, 0);
        ctx.restore();

        ctx.fillStyle = '#475569';
        ctx.font = '12px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`Distance (${isUS ? 'ft' : 'm'})`, PAD.left + plotW / 2, H - 6);

        // Timestamp
        const times = ts && ts.times;
        const timeLabel = (times && times[step]) ? times[step] : (step > 0 ? `Step ${step}` : '');
        if (timeLabel) {
            ctx.fillStyle = '#2563eb';
            ctx.font = 'italic 11px Inter, system-ui, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(timeLabel, W - PAD.right, H - 6);
        }

        // Legend
        drawLegend(geo.segments.some(s => s.cap >= 1.0), geo.segments.some(s => s.cap >= 0.85 && s.cap < 1.0));
    }

    function drawLegend(hasSurcharged, hasNearFull) {
        const items = [
            { fill: 'rgba(0,188,212,0.72)',   stroke: '#0284c7',  label: 'Water Surface' },
            { fill: 'rgba(148,163,184,0.25)', stroke: '#334155',  label: 'Pipe Section' },
            { fill: null,                      stroke: '#16a34a',  dash: true, label: 'Ground Level' },
        ];
        if (hasNearFull)  items.push({ fill: 'rgba(245,158,11,0.70)', stroke: '#b45309', label: 'Near Full (≥85%)' });
        if (hasSurcharged) items.push({ fill: 'rgba(220,38,38,0.65)', stroke: '#b91c1c', label: 'Surcharged' });

        ctx.font = '10px Inter, system-ui, sans-serif';
        let lx = PAD.left + 8;
        const ly = PAD.top + 10;
        const bw = 18, bh = 10;

        for (const item of items) {
            if (item.dash) {
                ctx.setLineDash([4, 3]);
                ctx.strokeStyle = item.stroke;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(lx, ly + bh / 2);
                ctx.lineTo(lx + bw, ly + bh / 2);
                ctx.stroke();
                ctx.setLineDash([]);
            } else {
                if (item.fill) { ctx.fillStyle = item.fill; ctx.fillRect(lx, ly, bw, bh); }
                ctx.strokeStyle = item.stroke;
                ctx.lineWidth = 1;
                ctx.strokeRect(lx, ly, bw, bh);
            }
            ctx.fillStyle = '#334155';
            ctx.textAlign = 'left';
            ctx.fillText(item.label, lx + bw + 4, ly + bh - 1);
            lx += bw + 4 + ctx.measureText(item.label).width + 16;
        }
    }

    // 5. CANVAS SIZING
    function resizeCanvas() {
        if (!canvasEl || !modalEl || modalEl.classList.contains('hidden')) return;
        const body = document.getElementById('profile-body');
        if (!body) return;
        const rect = body.getBoundingClientRect();
        const dpr  = window.devicePixelRatio || 1;
        const w    = Math.max(300, rect.width);
        const h    = Math.max(180, rect.height);
        canvasEl.width  = w * dpr;
        canvasEl.height = h * dpr;
        canvasEl.style.width  = w + 'px';
        canvasEl.style.height = h + 'px';
        ctx.scale(dpr, dpr);
        draw(currentStep);
    }

    // 6. PUBLIC API
    function openForNodes(nodeIds) {
        if (nodeIds.length < 2) {
            alert('Select at least 2 connected nodes to view a profile.');
            return;
        }

        const path = tracePath(nodeIds);
        if (!path || !path.edges.length) {
            alert('No connected conduit path found between the selected nodes.\nMake sure the nodes are connected by conduits.');
            return;
        }

        currentPath = path;

        // Update modal title
        const titleEl = document.getElementById('profile-title');
        if (titleEl) titleEl.textContent = `Water Elevation Profile: ${path.nodeIds.join(' → ')}`;

        modalEl.classList.remove('hidden');

        // Small delay so layout is computed before sizing
        setTimeout(resizeCanvas, 50);
    }

    function update(step) {
        if (!modalEl || modalEl.classList.contains('hidden') || !currentPath) return;
        draw(step);
    }

    function close() {
        if (modalEl) modalEl.classList.add('hidden');
    }

    // 7. DRAGGING
    function initDrag(modal, handle) {
        let ox = 0, oy = 0, ml = 0, mt = 0;

        handle.addEventListener('mousedown', e => {
            if (e.target.closest('button')) return;
            const rect = modal.getBoundingClientRect();
            ml = rect.left; mt = rect.top;
            ox = e.clientX; oy = e.clientY;
            modal.style.right = 'auto'; modal.style.bottom = 'auto';
            modal.style.transition = 'none';

            const move = ev => {
                modal.style.left = (ml + ev.clientX - ox) + 'px';
                modal.style.top  = (mt + ev.clientY - oy) + 'px';
            };
            const up = () => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
    }

    // 8. INIT
    function init() {
        modalEl  = document.getElementById('profile-modal');
        canvasEl = document.getElementById('profile-canvas');
        if (!modalEl || !canvasEl) return;

        ctx = canvasEl.getContext('2d');

        const header = document.getElementById('profile-header');
        if (header) initDrag(modalEl, header);

        document.getElementById('btn-profile-close')?.addEventListener('click', close);

        // Resize canvas when modal size changes
        const ro = new ResizeObserver(() => {
            if (!modalEl.classList.contains('hidden')) resizeCanvas();
        });
        ro.observe(document.getElementById('profile-body') || modalEl);

        window.addEventListener('resize', () => {
            if (!modalEl.classList.contains('hidden')) resizeCanvas();
        });
    }

    // Wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.ProfilePlot = { openForNodes, update, close };
})();
