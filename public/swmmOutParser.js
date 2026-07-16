class SWMMOutParser {
    constructor(arrayBuffer) {
        this.buffer = arrayBuffer;
        this.view = new DataView(this.buffer);
        this.parsed = false;
        
        this.counts = { subcatchments: 0, nodes: 0, links: 0, pollutants: 0 };
        this.offsets = { idNames: 0, objProps: 0, results: 0 };
        this.numPeriods = 0;
        this.errCode = 0;
        
        this.names = { subcatchments: [], nodes: [], links: [], pollutants: [] };
        
        // Data arrays: [period_index][object_index][variable_index]
        this.results = {
            times: [], // doubles
            subcatchments: [], // array of Float32Arrays
            nodes: [], // array of Float32Arrays
            links: [], // array of Float32Arrays
            system: [] // array of Float32Arrays
        };
    }

    parse() {
        if (this.buffer.byteLength < 24) {
            console.error("File too small to be a SWMM .out file");
            return false;
        }

        // Read footer (last 6 INT32s)
        const footerOffset = this.buffer.byteLength - 24;
        const magicEnd = this.view.getInt32(footerOffset + 20, true);
        if (magicEnd !== 516114522) {
            console.error("Invalid SWMM Magic Number at EOF", magicEnd);
            return false;
        }

        this.offsets.idNames = this.view.getInt32(footerOffset, true);
        this.offsets.objProps = this.view.getInt32(footerOffset + 4, true);
        this.offsets.results = this.view.getInt32(footerOffset + 8, true);
        this.numPeriods = this.view.getInt32(footerOffset + 12, true);
        this.errCode = this.view.getInt32(footerOffset + 16, true);

        // Read Header
        const magicStart = this.view.getInt32(0, true);
        const version = this.view.getInt32(4, true);
        const flowUnits = this.view.getInt32(8, true);
        this.counts.subcatchments = this.view.getInt32(12, true);
        this.counts.nodes = this.view.getInt32(16, true);
        this.counts.links = this.view.getInt32(20, true);
        this.counts.pollutants = this.view.getInt32(24, true);

        this.readIDNames();
        this.readResults();

        this.parsed = true;
        return true;
    }

    readIDNames() {
        let pos = this.offsets.idNames;
        const readString = () => {
            const len = this.view.getInt32(pos, true);
            pos += 4;
            let str = "";
            for (let i = 0; i < len; i++) {
                str += String.fromCharCode(this.view.getUint8(pos + i));
            }
            pos += len;
            return str;
        };

        for (let i = 0; i < this.counts.subcatchments; i++) this.names.subcatchments.push(readString());
        for (let i = 0; i < this.counts.nodes; i++) this.names.nodes.push(readString());
        for (let i = 0; i < this.counts.links; i++) this.names.links.push(readString());
        for (let i = 0; i < this.counts.pollutants; i++) this.names.pollutants.push(readString());
    }

    readResults() {
        let pos = this.offsets.results;
        
        const subcatchVars = 8 + this.counts.pollutants;
        const nodeVars = 6 + this.counts.pollutants;
        const linkVars = 5 + this.counts.pollutants;
        const sysVars = 14;

        for (let p = 0; p < this.numPeriods; p++) {
            if (pos + 8 > this.buffer.byteLength - 24) break;
            
            // Read time (double)
            const time = this.view.getFloat64(pos, true);
            this.results.times.push(time);
            pos += 8;

            // Subcatchments
            const bytesSub = this.counts.subcatchments * subcatchVars * 4;
            this.results.subcatchments.push(new Float32Array(this.buffer.slice(pos, pos + bytesSub)));
            pos += bytesSub;

            // Nodes
            const bytesNode = this.counts.nodes * nodeVars * 4;
            this.results.nodes.push(new Float32Array(this.buffer.slice(pos, pos + bytesNode)));
            pos += bytesNode;

            // Links
            const bytesLink = this.counts.links * linkVars * 4;
            this.results.links.push(new Float32Array(this.buffer.slice(pos, pos + bytesLink)));
            pos += bytesLink;

            // System
            const bytesSys = sysVars * 4;
            this.results.system.push(new Float32Array(this.buffer.slice(pos, pos + bytesSys)));
            pos += bytesSys;
        }
    }

    // Helper to extract a full time series for a specific element and variable
    getTimeSeries(type, index, varIndex) {
        if (!this.parsed) return [];
        let dataArray = null;
        let numVars = 0;

        if (type === 'SUBCATCHMENT') { dataArray = this.results.subcatchments; numVars = 8 + this.counts.pollutants; }
        else if (type === 'NODE') { dataArray = this.results.nodes; numVars = 6 + this.counts.pollutants; }
        else if (type === 'LINK') { dataArray = this.results.links; numVars = 5 + this.counts.pollutants; }
        else return [];

        const series = new Float32Array(this.numPeriods);
        for (let p = 0; p < this.numPeriods; p++) {
            if (dataArray[p]) {
                series[p] = dataArray[p][index * numVars + varIndex];
            } else {
                series[p] = 0;
            }
        }
        return series;
    }

    // Helper to get all values at a specific time step
    getStepData(type, stepIndex, varIndex) {
        if (!this.parsed) return [];
        let dataArray = null;
        let count = 0;
        let numVars = 0;

        if (type === 'SUBCATCHMENT') { dataArray = this.results.subcatchments; count = this.counts.subcatchments; numVars = 8 + this.counts.pollutants; }
        else if (type === 'NODE') { dataArray = this.results.nodes; count = this.counts.nodes; numVars = 6 + this.counts.pollutants; }
        else if (type === 'LINK') { dataArray = this.results.links; count = this.counts.links; numVars = 5 + this.counts.pollutants; }
        else return [];

        if (stepIndex < 0 || stepIndex >= this.numPeriods || !dataArray[stepIndex]) return new Float32Array(count);

        const stepVals = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            stepVals[i] = dataArray[stepIndex][i * numVars + varIndex];
        }
        return stepVals;
    }
}

window.SWMMOutParser = SWMMOutParser;
