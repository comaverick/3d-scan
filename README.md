# BuildWise SmartScan

BuildWise SmartScan is a web-first room capture and customization prototype.

## Web workflow

1. Open the site over HTTPS on a mobile phone. Camera and motion permissions do not work from an insecure phone URL.
2. Tap **Start scan** and walk through the room while the camera is running.
3. The browser analyzes frame sharpness, exposure, visual detail, scene change, orientation, motion, and camera translation. It saves overlapping keyframes only when they add usable coverage.
4. Follow the calm next-best-view instruction and coverage map. Guidance is based on the next useful room area, not on individual blur, exposure, speed, or feature-count readings.
5. Finish when the measured coverage and viewpoint diversity are sufficient, or use **Finish anyway** after the minimum usable scan has been collected. Use **Build real 3D room** to send the frames to the reconstruction worker, or export the JSON session for processing elsewhere.

### Scan behavior and debugging

- Every camera frame is evaluated, but only usable keyframes advance coverage. Blurry, dark, low-feature, and duplicate frames are discarded without interrupting the user.
- `SCANNING_WITH_WARNING` may briefly show **Move a little slower**; it never resets progress or enters recovery. `TRACKING_LOST` requires severe tracking, feature, image, relocalization, and recent-keyframe signals to agree for about 3.2 seconds.
- Readiness uses accepted keyframes, weighted structural coverage, floor and wall coverage, and viewpoint diversity. It does not require 100% of the view-sector map.
- Add `?scannerDebug=1` in development to show motion EMA values, adaptive thresholds, tracking state, relocalization attempts, accepted/rejected keyframe counts, rejection reasons, coverage, and readiness.

The website also works as a desktop review/customization tool without a camera. Desktop users can load a scan exported from a phone or an API result containing `room.glb`/`meshPLY`.

## Real photogrammetry backend

The `backend/` directory contains a FastAPI worker boundary for actual reconstruction. It runs COLMAP feature extraction, matching, structure-from-motion, dense multi-view stereo, Open3D mesh reconstruction, and GLB export. Start it with the instructions in [`backend/README.md`](backend/README.md), then set `REACT_APP_RECONSTRUCTION_API` when the API is not served from the same origin.

## Native iOS reconstruction workflow

The native iOS target uses ARKit scene reconstruction on LiDAR-equipped devices. It writes a classified room mesh as ASCII PLY inside the manifest, including wall, floor, ceiling, table, seat, window, and door surface groups. On iOS 17 and newer it also runs Vision image classification on useful frames and exports furniture observations with confidence and approximate camera positions.

Importing that manifest in the website renders the real mesh when `meshPLY` is present. A browser-only session without `meshPLY` is intentionally not turned into a fake room: the viewer reports that a native LiDAR scan is required.

## What is real today

- Camera frames come from `getUserMedia`, not the placeholder room illustration.
- Orientation and motion signals are recorded when the browser grants sensor access; camera analysis still runs when sensors are unavailable.
- Adaptive guidance is driven by measured frame quality, image change, observed view sectors, camera movement, and parallax—not a fixed four-wall route or a timer.
- Scan sessions contain embedded images, synchronized poses/orientation/motion, quality metrics, coverage summaries, timestamps, and a version number.
- The 3D room viewer renders only the imported classified mesh, visualizes the tracking path, and previews material changes on the scanned wall, floor, and ceiling surfaces.

## Important limitation

Web browsers do not expose ARKit's room-mesh reconstruction across all mobile devices. Use the native iOS target on a LiDAR-equipped iPhone or iPad for the real mesh path. Non-LiDAR devices can still produce camera and tracking metadata, but those sessions are not presented as a 3D room. Vision furniture observations are metadata only; they do not create or add furniture to the simulator.

## Run locally

```bash
npm install
npm start
```

For a phone on the same network, use an HTTPS dev tunnel or deploy the production build to HTTPS. A plain `http://localhost` works on the development computer, but phone camera access normally requires HTTPS.

```bash
npm test -- --watchAll=false --runInBand
npm run build
```

The native ARKit path remains under `ios/BuildWiseSmartScan` for devices that support LiDAR scene reconstruction. The browser path is camera-first and can feed the real COLMAP pipeline without pretending that keyframes are already a 3D room.
