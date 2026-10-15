import math
from concurrent.futures import ThreadPoolExecutor
from itertools import repeat
from pathlib import Path

import rasterio
from pystac_client import Client
from rasterio.errors import RasterioError
from rasterio.warp import transform_bounds
from rasterio.windows import Window, from_bounds
from rich.console import Console

BBOX = (
    -46.67024309989499,
    -23.554796622349986,
    -46.618515000105006,
    -23.507370044316684,
)


def iter_item(items):
    seen = set()
    for item in items.items():
        if not item.id.startswith(("LC08_", "LC09_")) or item.id in seen:
            continue
        seen.add(item.id)
        yield item


def download_item(item, output_dir: Path) -> bool | None:
    try:
        with (
            rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"),
            rasterio.open(item.assets["lwir11"].href) as src,
        ):
            bounds = transform_bounds("EPSG:4326", src.crs, *BBOX)
            requested = from_bounds(*bounds, transform=src.transform)
            left = math.floor(requested.col_off)
            top = math.floor(requested.row_off)
            right = math.ceil(requested.col_off + requested.width)
            bottom = math.ceil(requested.row_off + requested.height)
            if not (0 <= left < right <= src.width and 0 <= top < bottom <= src.height):
                return None
            window = Window.from_slices(
                rows=(top, bottom),
                cols=(left, right),
            )
            with rasterio.open(item.assets["qa_pixel"].href) as qa_src:
                qa = qa_src.read(1, window=window, masked=True)
            if ((qa & 0b111111) != 0).filled().any():
                return None

            readings = src.read(1, window=window, masked=True)
            if (readings == 0).filled().any():
                return None
            readings = readings.astype("float32") * 0.00341802 + 149.0 - 273.15
            profile = src.profile.copy()
            profile.update(
                width=window.width,
                height=window.height,
                transform=src.window_transform(window),
                dtype="float32",
            )
            output_dir.mkdir(parents=True, exist_ok=True)
            path = output_dir / f"{item.id}_LST_C.tif"
            with rasterio.open(path, "w", **profile) as dst:
                dst.write(readings.data, 1)
                dst.set_band_unit(1, "degC")
        return True

    except RasterioError, OSError:
        return False


def main() -> None:
    catalog = Client.open("https://data.inpe.br/bdc/stac/v1/")
    items = catalog.search(
        collections="landsat-2", bbox=BBOX, datetime="2013-01-01T00:00:00Z/.."
    )
    output_dir = Path("output")
    downloaded = 0
    failed = 0

    with (
        Console().status("Baixando imagens..."),
        ThreadPoolExecutor(max_workers=4) as executor,
    ):
        for saved in executor.map(
            download_item, iter_item(items), repeat(output_dir), buffersize=4
        ):
            if saved:
                downloaded += 1
            elif saved is False:
                failed += 1

    summary = f"{downloaded} baixados com sucesso"
    if failed:
        summary += f", não puderam ser baixados: {failed}"
    print(summary)


if __name__ == "__main__":
    main()
