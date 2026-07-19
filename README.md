# SWMM6 Web Visualizer

Web-based GIS visualization, planning, and simulation platform for SWMM hydraulic models and GeoJSON networks.

## Overview
<img width="1873" height="922" alt="image" src="https://github.com/user-attachments/assets/1ae23cd3-7f55-4bff-8d4f-f8a7824f102d" />

provides an interactive, modern web interface for viewing, managing, and simulating stormwater and wastewater networks. It brings traditional SWMM modeling into a 3D geospatial environment using Mapbox GL JS, making it easier to analyze infrastructure alongside real-world terrain, 3D buildings, and Google Street View.

Under the hood, it leverages the powerful [openswmm.engine](https://github.com/HydroCouple/openswmm.engine) by HydroCouple, a dynamic hydrology-hydraulic water quality simulation model for stormwater, wastewater, and combined sewer collection systems.

## Key Features

- **Geospatial Visualization:** Render urban drainage networks over 3D terrain and interactive building layers.
- **Drag & Drop Import:** Easily load SWMM `.inp` models and custom `GeoJSON` spatial layers.
- **Dynamic Layer Styling:** Change the color and visibility of individual network layers and background base maps on the fly.
- **Street View Integration:** Drop a pegman to view the exact real-world locations of your junctions, outfalls, and conduits via Google Street View.
- **Advanced Simulation Engine:** Full integration with the HydroCouple OpenSWMM engine for accurate and modern hydraulic simulation capabilities.

## Getting Started

1. Clone this repository.
2. Open the project in your preferred web environment.
3. Serve the `public` directory using a local web server (e.g., Python's `http.server`, Live Server for VS Code, or Node.js).
4. Navigate to `index.html` in your browser.

## Technologies Used

- [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/api/) for 3D web mapping.
- [openswmm.engine](https://github.com/HydroCouple/openswmm.engine) via WebAssembly (Wasm) for in-browser simulation.
- Vanilla HTML, CSS, and JavaScript.

## License

This project's UI and frontend code are released under the [MIT License](LICENSE). The underlying simulation engine is provided by the [HydroCouple OpenSWMM project](https://github.com/HydroCouple/openswmm.engine) which operates under its respective open-source licensing.
