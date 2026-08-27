# SmartScan reconstruction worker

This service is the real reconstruction boundary for the web scanner. It never creates a rectangular room, image cube, panorama, or placeholder furniture.

## Run locally

Install Python dependencies and install the native [COLMAP](https://colmap.github.io/) executable on the worker machine, then run:

```bash
python -m pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

## Pipeline

`POST /api/scans` creates a scan. `POST /api/scans/{scanId}/frames` stores JPEG/PNG keyframes plus synchronized orientation, motion, pose, and quality metadata. `POST /api/scans/{scanId}/reconstruct` starts the real pipeline:

1. COLMAP feature extraction
2. COLMAP exhaustive matching
3. COLMAP mapper / structure-from-motion
4. COLMAP image undistortion
5. COLMAP PatchMatch stereo and stereo fusion
6. Open3D Poisson surface reconstruction
7. GLB export using measured mesh vertices and MVS vertex colors when available

The status endpoint reports the actual stage. Missing COLMAP, too few overlapping frames, failed camera recovery, and insufficient dense points are returned as errors; no fake result is reported as complete.

The current worker accepts an explicit `scale_factor`. Marker detection and manual two-point calibration should populate that value before production metric dimensions are shown.
