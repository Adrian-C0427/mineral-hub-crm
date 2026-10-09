import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

// MapLibre 6 is ESM-only and spawns its tile worker from a URL it derives from
// its own module location (`./maplibre-gl-worker.mjs`). Once Vite bundles the
// library into a hashed chunk that file is never emitted, so every map would
// fail to load tiles. Importing the worker with `?url` makes Vite emit it as an
// asset; registering it here — imported by every component that creates a map,
// before any Map is constructed — points MapLibre at the real file.
maplibregl.setWorkerUrl(workerUrl);
