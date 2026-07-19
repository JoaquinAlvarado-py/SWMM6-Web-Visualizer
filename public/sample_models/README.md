# Sample Models

## Bellinge — real urban drainage system (Odense, Denmark)

A real, community-wide combined-sewer model of Bellinge, a suburb of Odense, Denmark,
published as open data by DTU and the utility VCS Denmark.

| File | Purpose |
|------|---------|
| `BellingeSWMM_v021_nopervious.inp` | Original model as published. Rain gauges read from the external `.dat` file, so it only runs in engines that can see that file on disk. |
| `BellingeSWMM_v021_selfcontained.inp` | Same model with the two `FILE`-based rain gauges converted to inline `[TIMESERIES]` (storm of 29–30 June 2012, ~30 mm). Runs standalone. |
| `BellingeSWMM_v021_web.inp` | Self-contained variant tuned for the browser: `REPORT_STEP` 5 min instead of 1 min, subcatchments excluded from the binary output, summary-only text report. Identical physics (same 4 s routing step). **Use this one in the web app.** |
| `rg_bellinge_Jun2010_Aug2021.dat` | Original 1-minute rain gauge record (2009–2021) for gauges rg5425 and rg5427. Only needed by the original `.inp`. |

Benchmarks with the app's own `swmm6wasm` engine (Node 24, single-threaded):
`selfcontained` = 254 s simulation, **195.7 MB** binary `.out`;
`web` = 232 s simulation, **26.2 MB** `.out` (nodes + links at 5-min steps — everything
the results viewer reads). In this engine the `[REPORT]` NODES/LINKS selection controls
the binary `.out` contents too, so don't set them to `NONE` if you want animations.

### Network contents

995 junctions, 1015 conduits, 713 subcatchments, 16 storage units, 9 outfalls,
6 pumps, 13 weirs, 3 orifices, 7 outlets, 28 control rules, dry-weather flows.
Dynamic wave routing, 4 s routing step, 2-day simulation (29–30 June 2012).

### Coordinates (check on the map)

- CRS: **ETRS89 / UTM zone 32N — EPSG:25832** (enter `EPSG:25832` in the UTM
  reprojection prompt when importing).
- Network center: **55.34264 N, 10.31817 E** → <https://maps.google.com/?q=55.34264,10.31817>
- Bounding box: SW 55.33070, 10.25831 → NE 55.35849, 10.36854

### Source & license

- Dataset: Nedergaard Pedersen et al. (2021), *The Bellinge data set: open data and
  models for community-wide urban drainage systems research*, Earth Syst. Sci. Data 13,
  4779–4798. <https://doi.org/10.5194/essd-13-4779-2021>
- Model files: DTU Data, item "7 - Models", DOI 10.11583/DTU.12513428, **CC BY 4.0**.
  <https://data.dtu.dk/collections/Dataset_for_Bellinge_An_urban_drainage_case_study/5029124>
