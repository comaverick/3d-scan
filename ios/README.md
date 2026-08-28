# BuildWise SmartScan iOS scanner

This is the native scanner core for the SmartScan room reconstruction path. It uses `ARWorldTrackingConfiguration` and enables classified LiDAR mesh reconstruction when the device supports it. Ordinary ARKit-compatible iPhones keep the RGB camera and world-tracking fallback.

## Run it

1. On a Mac, install Xcode 15 or newer.
2. Open `ios/BuildWiseSmartScan.xcodeproj`.
3. Set your Apple development team under the target's Signing & Capabilities settings.
4. Select a physical iPhone. ARKit world tracking is not available in the iOS Simulator.
5. Build and run, then tap **Start Scan** and grant camera permission.

## Polycam-style live scanning

- The first normally tracked AR frame becomes the origin.
- LiDAR-capable devices enable ARKit scene reconstruction and scene depth. The room mesh appears live over the camera as ARKit updates its mesh anchors.
- Blue dots and connecting grid lines mark screen areas without usable depth. As depth becomes available, those blue marks disappear. Keep moving until the blue areas are covered, then add another angle for overlap.
- The scanner saves overlapping keyframes automatically when the camera translates or rotates enough. There is no forced turn-and-return route; walk around the room at a steady pace and tap **Finish Scan** after at least three useful frames.
- Devices without LiDAR keep AR world tracking and frame capture, but cannot provide the same live room mesh or depth coverage guide.

Each useful frame is written as a JPEG under the app's `Documents/ScanSessions/<session-id>/` directory, alongside a versioned `manifest.json` containing the ARKit world-space origin, frame poses, timestamps, yaw, coverage, and scan duration. On LiDAR devices the manifest also contains an ASCII PLY room mesh with per-face classification, a surface summary, and Vision furniture observations from iOS 17+. The review card can share the manifest and captured images through the iOS share sheet. Files are also exposed through the Files app because document sharing is enabled.

The native target now produces the actual room mesh locally on LiDAR hardware. The website can render that mesh and apply different wall, floor, and ceiling materials. Vision furniture observations are metadata only; the viewer does not insert invented furniture or image panels. Detailed object-level furniture geometry can be added later only with a reconstruction model that fits geometry to the scan.
