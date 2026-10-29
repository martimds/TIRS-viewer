import * as maplibregl from "https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.mjs";
import { fromArrayBuffer } from "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/+esm";
import proj4 from "https://cdn.jsdelivr.net/npm/proj4@2.22.0/+esm";

const stops = ["000004", "420a68", "932667", "dd513a", "fca50a", "fcffa4"].map(
  (c) => [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)),
);
const palette = Array.from({ length: 256 }, (_, i) => {
  const x = (i / 255) * (stops.length - 1);
  const j = Math.min(Math.floor(x), stops.length - 2);
  return stops[j].map((a, k) => a + (stops[j + 1][k] - a) * (x - j));
});

const html = await fetch("output/").then((r) => r.text());
const names = [...new DOMParser().parseFromString(html, "text/html").links]
  .map((a) => a.getAttribute("href"))
  .filter((name) => name.endsWith(".tif"));

const rasters = await Promise.all(
  names.map(async (name) => {
    const tiff = await fromArrayBuffer(
      await fetch(`output/${name}`).then((r) => r.arrayBuffer()),
    );
    const image = await tiff.getImage();
    const [sensor, , , captured, processed] = name.split("_");
    return {
      satellite: `Landsat ${+sensor.slice(2)}`,
      captured,
      processed,
      image,
      data: (await image.readRasters())[0],
    };
  }),
);

const { image } = rasters[0];
const width = image.getWidth();
const height = image.getHeight();
const [l, b, r, t] = image.getBoundingBox();
const coordinates = [
  [l, t],
  [r, t],
  [r, b],
  [l, b],
].map((p) => proj4("+proj=utm +zone=23 +datum=WGS84 +units=m", "EPSG:4326", p));

rasters.sort(
  (a, b) =>
    a.captured.localeCompare(b.captured) ||
    a.processed.localeCompare(b.processed),
);

const values = Float32Array.from(
  rasters.flatMap(({ data }) => [...data]),
).sort();
const [vmin, vmax] = [0.01, 0.99].map(
  (q) => values[Math.round(q * (values.length - 1))],
);

const formatDate = (d) => `${d.slice(6)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;

const scenes = rasters.map(({ satellite, captured, processed, data }) => {
  const canvas = Object.assign(document.createElement("canvas"), {
    width,
    height,
  });
  const ctx = canvas.getContext("2d");
  const rgba = ctx.createImageData(width, height);
  data.forEach((v, i) => {
    const index = Math.floor(
      Math.min(Math.max((v - vmin) / (vmax - vmin), 0), 1) * 255,
    );
    rgba.data.set([...palette[index], 255], i * 4);
  });
  ctx.putImageData(rgba, 0, 0);
  return {
    label: `${satellite} - Capturado em ${formatDate(captured)}; processado em ${formatDate(processed)}.`,
    warning:
      satellite === "Landsat 9" &&
      captured === "20230209" &&
      processed === "20230212",
    data,
    url: canvas.toDataURL(),
    coordinates,
  };
});

const lngs = coordinates.map(([lng]) => lng);
const lats = coordinates.map(([, lat]) => lat);
const bounds = [
  Math.min(...lngs),
  Math.min(...lats),
  Math.max(...lngs),
  Math.max(...lats),
];
const [w, s, e, n] = bounds;

const map = new maplibregl.Map({
  container: "map",
  bounds,
  style: {
    version: 8,
    sources: {
      satellite: {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
      },
      lst: {
        type: "image",
        url: scenes.at(-1).url,
        coordinates,
      },
    },
    layers: [
      { id: "satellite", type: "raster", source: "satellite" },
      {
        id: "lst",
        type: "raster",
        source: "lst",
        paint: { "raster-opacity": 0.8 },
      },
    ],
  },
});

await map.once("load");
map.setMaxBounds([2 * w - e, 2 * s - n, 2 * e - w, 2 * n - s]);

const showInfo = ({ label, warning: hasWarning }) => {
  info.textContent = label;
  warning.hidden = !hasWarning;
};

scene.max = scenes.length - 1;
scene.value = scene.max;
showInfo(scenes.at(-1));

scene.oninput = () => {
  map.getSource("lst").updateImage(scenes[scene.value]);
  showInfo(scenes[scene.value]);
};
visible.onchange = () =>
  map.setLayoutProperty(
    "lst",
    "visibility",
    visible.checked ? "visible" : "none",
  );
opacity.oninput = () =>
  map.setPaintProperty("lst", "raster-opacity", +opacity.value);

const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

map.on("mousemove", ({ lngLat }) => {
  const [x, y] = proj4("+proj=utm +zone=23 +datum=WGS84 +units=m", [
    lngLat.lng,
    lngLat.lat,
  ]);
  const col = Math.floor(((x - l) / (r - l)) * width);
  const row = Math.floor(((t - y) / (t - b)) * height);
  if (!visible.checked || col < 0 || col >= width || row < 0 || row >= height) {
    popup.remove();
    return;
  }
  const temperature = scenes[scene.value].data[row * width + col];
  popup
    .setLngLat(lngLat)
    .setHTML(
      `<b style="font-size: 20px">${temperature.toFixed(1)} °C</b><br>${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`,
    )
    .addTo(map);
});
map.on("mouseout", () => popup.remove());
