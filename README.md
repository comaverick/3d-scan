# BuildWise SmartScan

BuildWise SmartScan is a web-first room capture and customization prototype.

## Web workflow

1. Open the site over HTTPS on a mobile phone. Camera and motion permissions do not work from an insecure phone URL.
2. Tap **Start scan** and follow the guided movement checkpoints.
3. The mobile browser captures real JPEG keyframes and records heading, timestamps, and an estimated local movement path.
4. Finish the scan, open the room customizer, or export the scan as a JSON session.
5. Open the site on a desktop browser and use **Load scan** to import that JSON session. The captured frames, room footprint, and customization controls are then available on desktop.

The website also works as a desktop review/customization tool without a camera. Desktop users can load a scan exported from a phone.

## What is real today

- Camera frames come from `getUserMedia`, not the placeholder room illustration.
- Movement and heading signals advance guidance when the browser grants sensor access.
- Checkpoint progress is manual when sensors are unavailable; a timer does not fake scan progress.
- Scan sessions contain embedded images, poses, timestamps, and a version number, so they can move between phone and desktop without a backend.
- The room customizer can review captured frames, visualize the estimated path, preview furniture assets, change material tone and scale, and show a camera overlay.

## Important limitation

Web browsers do not expose ARKit's room-mesh reconstruction across all mobile devices. This prototype creates a reliable capture package for a reconstruction service and provides a camera-overlay customization fallback. Exact wall geometry and world-locked AR placement require either a WebXR-capable device/browser or a backend that reconstructs the room from the exported images.

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

The earlier native ARKit proof of feasibility remains under `ios/BuildWiseSmartScan`, but the primary product flow is now the web capture/import/customization path.
